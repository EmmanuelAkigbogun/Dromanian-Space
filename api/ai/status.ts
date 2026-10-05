// GET /api/ai/status?workspace_id=… — honest configuration state for the AI
// features of one workspace (no secrets): provider, embeddings, web research,
// CRM tools, workspace limits and the caller's usage.
import { env } from '../../server/env.js';
import { errorResponse, HttpError, json } from '../../server/http.js';
import { crmInstalled } from '../../server/capabilities.js';
import { embeddingsConfigured } from '../../server/knowledge/embed.js';
import { toolAvailability } from '../../server/agents/tools/index.js';
import { authenticate, requireMember, rpc } from '../../server/supabase.js';

interface Settings {
  enabled: boolean;
  default_model: string;
  allowed_models: string[];
  monthly_token_budget: number | null;
  per_user_daily_token_budget: number | null;
  max_concurrent_runs: number;
  web_research_enabled: boolean;
  mention_reply_policy: string;
}

const KNOWN_TOOLS = [
  'search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks', 'read_crm_record',
  'compute_csv_metrics', 'web_search', 'propose_task', 'propose_document', 'propose_channel_message', 'propose_crm_update',
];

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const workspaceId = new URL(request.url).searchParams.get('workspace_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, 'invalid_request', 'workspace_id is required.');
    await requireMember(workspaceId, user.id);
    const [settings, totals, crm] = await Promise.all([
      rpc<Settings>('ai_settings_for', { p_workspace_id: workspaceId }),
      rpc<Array<{ workspace_month: number; user_day: number }>>('ai_usage_totals', { p_workspace_id: workspaceId, p_user_id: user.id }),
      crmInstalled(),
    ]);
    const providerConfigured = Boolean(env().anthropicApiKey);
    return json({
      provider: { name: 'anthropic', configured: providerConfigured, refusal_fallback: env().refusalFallback },
      embeddings: { configured: embeddingsConfigured(), model: embeddingsConfigured() ? env().embeddingModel : null },
      web_research: { enabled_by_admin: settings.web_research_enabled, available: providerConfigured && settings.web_research_enabled },
      crm: { installed: crm },
      settings: {
        enabled: settings.enabled,
        default_model: settings.default_model,
        allowed_models: settings.allowed_models,
        monthly_token_budget: settings.monthly_token_budget,
        per_user_daily_token_budget: settings.per_user_daily_token_budget,
        max_concurrent_runs: settings.max_concurrent_runs,
        mention_reply_policy: settings.mention_reply_policy,
      },
      usage: { workspace_month_tokens: totals[0]?.workspace_month ?? 0, user_day_tokens: totals[0]?.user_day ?? 0 },
      tools: toolAvailability(KNOWN_TOOLS, { webResearchEnabled: settings.web_research_enabled, crmInstalled: crm }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
