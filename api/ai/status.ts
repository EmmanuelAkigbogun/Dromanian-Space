// GET /api/ai/status?workspace_id=… — honest configuration state for the AI
// features of one workspace (no secrets): provider, embeddings, web research,
// site and brand kit, external connectors, CRM, limits and the caller's usage.
import { env } from '../../server/env.js';
import { anyProviderConfigured, PROVIDER_LABELS, providerNameFor, providerStates } from '../../server/ai/registry.js';
import { errorResponse, HttpError, json } from '../../server/http.js';
import { crmInstalled } from '../../server/capabilities.js';
import { embeddingsConfigured } from '../../server/knowledge/embed.js';
import { KNOWN_TOOLS, toolAvailability } from '../../server/agents/tools/index.js';
import { authenticate, requireMember, rpc, serviceClient } from '../../server/database.js';
import { providerKeySource } from '../../server/provider-secrets.js';

interface Settings {
  enabled: boolean;
  default_model: string;
  allowed_models: string[];
  monthly_token_budget: number | null;
  per_user_daily_token_budget: number | null;
  max_concurrent_runs: number;
  web_research_enabled: boolean;
  mention_reply_policy: string;
  brand_kit_folder_id: string | null;
  site_url: string | null;
}

/** Connections agents can use for extra actions; none is simulated. */
export const CONNECTORS: Record<string, string> = {
  support_inbox: 'Help desk or support inbox',
  commerce_store: 'Online store (for example Medusa)',
  email_platform: 'Email marketing platform',
  recruiting: 'Recruiting system',
  search_analytics: 'Search analytics',
  social_accounts: 'Social media accounts',
  email_inbox: 'Email inbox',
};

interface CatalogRow {
  id: string;
  provider: string | null;
  label: string;
  tier: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  active: boolean;
}

/** Models a workspace can choose from, marked available when the server has the provider's key. */
function catalogModels(rows: CatalogRow[] | null, allowed: string[], configured: Set<string>) {
  // Before the provider migration is applied, the allowed list is the catalog.
  const source: CatalogRow[] =
    rows ?? allowed.map((id) => ({ id, provider: providerNameFor(id), label: id, tier: 'standard', input_per_mtok: null, output_per_mtok: null, active: true }));
  return source
    .filter((m) => m.active || allowed.includes(m.id))
    .map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      tier: m.tier,
      priced: m.input_per_mtok !== null && m.output_per_mtok !== null,
      available: Boolean(m.provider && configured.has(m.provider)),
    }));
}

interface CostRow {
  provider: string;
  model: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | string | null;
  unpriced_rows: number;
}

/** Estimated spend this month (admins only). */
async function costSummary(workspaceId: string) {
  const rows = await rpc<CostRow[]>('ai_cost_summary', { p_workspace_id: workspaceId }).catch(() => null);
  if (!rows) return null;
  return {
    month_usd: Number(rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0).toFixed(4)),
    unpriced_rows: rows.reduce((sum, r) => sum + Number(r.unpriced_rows ?? 0), 0),
    by_model: rows.map((r) => ({ ...r, cost_usd: r.cost_usd === null ? null : Number(r.cost_usd) })),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, 'invalid_request', 'workspace_id is required.');
    await requireMember(workspaceId, user.id);
    const db = serviceClient();
    const [settings, totals, crm, connectorRows, catalog, membership] = await Promise.all([
      rpc<Settings>('ai_settings_for', { p_workspace_id: workspaceId }),
      rpc<Array<{ workspace_month: number; user_day: number }>>('ai_usage_totals', { p_workspace_id: workspaceId, p_user_id: user.id }),
      crmInstalled(),
      db.from('workspace_connectors').select('kind, status, display_name').eq('workspace_id', workspaceId),
      db.from('ai_models').select('id, provider, label, tier, input_per_mtok, output_per_mtok, active, sort_order').order('sort_order'),
      db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle(),
    ]);
    const isAdmin = ['owner', 'admin'].includes((membership.data?.role as string | undefined) ?? '');
    const canManageProviderKeys = user.appMetadata?.platform_admin === true;
    const providers = providerStates();
    const configured = new Set<string>(providers.filter((p) => p.configured).map((p) => p.name));
    const providerConfigured = anyProviderConfigured();
    const connected = new Map<string, { kind: string; status?: string }>(
      ((connectorRows.data ?? []) as Array<{ kind: string; status?: string }>).map((c) => [c.kind, c]),
    );
    const models = catalogModels(catalog.error ? null : (catalog.data as CatalogRow[] | null), settings.allowed_models, configured);
    const costs = isAdmin ? await costSummary(workspaceId) : null;
    const usedProviders = [...new Set(settings.allowed_models.map(providerNameFor))].filter(
      (p): p is 'anthropic' | 'openai' | 'gemini' | 'cerebras' => p !== null && configured.has(p),
    );
    return json({
      provider: { name: env().defaultProvider, configured: providerConfigured, refusal_fallback: env().refusalFallback },
      providers: providers.map((p) => ({ name: p.name, label: p.label, configured: p.configured })),
      provider_key_management: {
        allowed: canManageProviderKeys,
        providers: canManageProviderKeys
          ? providers.map((p) => ({ name: p.name, source: providerKeySource(p.name) }))
          : [],
      },
      models,
      costs,
      // Where data goes when agents work, stated plainly for workspace settings.
      data_flow: {
        generation: usedProviders.length
          ? `Agno coordinates the agents. Text generation uses ${usedProviders.map((p) => PROVIDER_LABELS[p]).join(' and ')}, depending on each agent's model (${settings.default_model} by default). Text from the sources an agent reads, and your messages to it, are sent to that provider to produce answers.`
          : "No provider is configured for this workspace's models; nothing is sent to a model provider.",
        embeddings: embeddingsConfigured()
          ? `Semantic search uses Voyage AI (${env().embeddingModel}); indexed document text is sent to Voyage to create embeddings.`
          : 'Semantic search is not configured; documents are indexed with full-text search inside your database only.',
        storage: 'Files, conversations, indexes and agent history are stored in this deployment\'s own database and storage.',
      },
      embeddings: { configured: embeddingsConfigured(), model: embeddingsConfigured() ? env().embeddingModel : null },
      web_research: {
        enabled_by_admin: settings.web_research_enabled,
        available: false,
        reason: settings.web_research_enabled ? 'An Agno web-search tool is not connected.' : 'Disabled by the workspace administrator.',
      },
      crm: { installed: crm },
      site: { url: settings.site_url },
      brand_kit: { folder_id: settings.brand_kit_folder_id },
      connectors: Object.entries(CONNECTORS).map(([kind, label]) => {
        const row = connected.get(kind);
        return { kind, label, status: row?.status === 'connected' ? 'connected' : row ? (row.status as string) : 'not_connected' };
      }),
      settings: {
        enabled: settings.enabled,
        default_model: settings.default_model,
        allowed_models: settings.allowed_models,
        monthly_token_budget: settings.monthly_token_budget,
        per_user_daily_token_budget: settings.per_user_daily_token_budget,
        max_concurrent_runs: settings.max_concurrent_runs,
        mention_reply_policy: settings.mention_reply_policy,
        web_research_enabled: settings.web_research_enabled,
      },
      usage: { workspace_month_tokens: totals[0]?.workspace_month ?? 0, user_day_tokens: totals[0]?.user_day ?? 0 },
      tools: toolAvailability(KNOWN_TOOLS, {
        webResearchEnabled: settings.web_research_enabled,
        crmInstalled: crm,
        siteUrl: settings.site_url,
        brandKitFolderId: settings.brand_kit_folder_id,
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
