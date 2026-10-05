// GET /api/ai/status?workspace_id=… — honest configuration state for the AI
// features of one workspace (no secrets): provider, embeddings, web research,
// site and brand kit, external connectors, CRM, limits and the caller's usage.
import { env } from '../../server/env.js';
import { errorResponse, HttpError, json } from '../../server/http.js';
import { crmInstalled } from '../../server/capabilities.js';
import { embeddingsConfigured } from '../../server/knowledge/embed.js';
import { KNOWN_TOOLS, toolAvailability } from '../../server/agents/tools/index.js';
import { authenticate, requireMember, rpc, serviceClient } from '../../server/supabase.js';

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

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, 'invalid_request', 'workspace_id is required.');
    await requireMember(workspaceId, user.id);
    const [settings, totals, crm, connectorRows] = await Promise.all([
      rpc<Settings>('ai_settings_for', { p_workspace_id: workspaceId }),
      rpc<Array<{ workspace_month: number; user_day: number }>>('ai_usage_totals', { p_workspace_id: workspaceId, p_user_id: user.id }),
      crmInstalled(),
      serviceClient().from('workspace_connectors').select('kind, status, display_name').eq('workspace_id', workspaceId),
    ]);
    const providerConfigured = Boolean(env().anthropicApiKey);
    const connected = new Map((connectorRows.data ?? []).map((c) => [c.kind as string, c]));
    return json({
      provider: { name: 'anthropic', configured: providerConfigured, refusal_fallback: env().refusalFallback },
      // Where data goes when agents work, stated plainly for workspace settings.
      data_flow: {
        generation: providerConfigured
          ? `Text generation uses Anthropic's API (${settings.default_model} by default). Text from the sources an agent reads, and your messages to it, are sent to Anthropic to produce answers.`
          : 'No model provider is configured; nothing is sent to a model provider.',
        embeddings: embeddingsConfigured()
          ? `Semantic search uses Voyage AI (${env().embeddingModel}); indexed document text is sent to Voyage to create embeddings.`
          : 'Semantic search is not configured; documents are indexed with full-text search inside your database only.',
        storage: 'Files, conversations, indexes and agent history are stored in this deployment\'s own database and storage.',
      },
      embeddings: { configured: embeddingsConfigured(), model: embeddingsConfigured() ? env().embeddingModel : null },
      web_research: { enabled_by_admin: settings.web_research_enabled, available: providerConfigured && settings.web_research_enabled },
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
