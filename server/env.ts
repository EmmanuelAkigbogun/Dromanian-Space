// Server-only configuration. Nothing here may be exposed through a VITE_
// variable or imported by browser code.

import { providerApiKey } from './provider-secrets.js';

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export interface ServerEnv {
  databaseUrl: string | null;
  databaseRestUrl: string;
  appJwtSecret: string | null;
  defaultWorkspaceSlug: string;
  defaultChannelSlug: string;
  anthropicApiKey: string | null;
  /** Server-side refusal fallback (`fallbacks: "default"`); on unless set to "off". */
  refusalFallback: boolean;
  openaiApiKey: string | null;
  /** Optional OpenAI-compatible endpoint (for example a regional or proxy URL). */
  openaiBaseUrl: string | null;
  openaiOrganization: string | null;
  openaiProject: string | null;
  geminiApiKey: string | null;
  /** Provider and model new workspaces start with (existing workspaces keep their choice). */
  defaultProvider: ProviderName;
  defaultModels: Record<ProviderName, string>;
  voyageApiKey: string | null;
  embeddingModel: string;
  cronSecret: string | null;
  /** Shared secret for signed n8n webhooks; the integration is off without it. */
  n8nWebhookSecret: string | null;
  n8nBaseUrl: string | null;
  /** VAPID keys for Web Push; push stays off unless all three are set. */
  webPush: { publicKey: string; privateKey: string; subject: string } | null;
  workerId: string;
}

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) {
    cached.anthropicApiKey = providerApiKey('anthropic');
    cached.openaiApiKey = providerApiKey('openai');
    cached.geminiApiKey = providerApiKey('gemini');
    return cached;
  }
  const provider = read('AI_DEFAULT_PROVIDER');
  cached = {
    databaseUrl: read('DATABASE_URL'),
    databaseRestUrl: read('DATABASE_REST_URL') ?? 'http://rest:3000',
    appJwtSecret: read('APP_JWT_SECRET'),
    defaultWorkspaceSlug: read('DEFAULT_WORKSPACE_SLUG') ?? 'digital-romanian',
    defaultChannelSlug: read('DEFAULT_CHANNEL_SLUG') ?? 'general',
    anthropicApiKey: providerApiKey('anthropic'),
    refusalFallback: read('ANTHROPIC_REFUSAL_FALLBACK') !== 'off',
    openaiApiKey: providerApiKey('openai'),
    openaiBaseUrl: read('OPENAI_BASE_URL'),
    openaiOrganization: read('OPENAI_ORG_ID'),
    openaiProject: read('OPENAI_PROJECT_ID'),
    geminiApiKey: providerApiKey('gemini'),
    defaultProvider: provider === 'openai' || provider === 'gemini' ? provider : 'anthropic',
    defaultModels: {
      anthropic: read('AI_DEFAULT_ANTHROPIC_MODEL') ?? 'claude-opus-5-5',
      openai: read('AI_DEFAULT_OPENAI_MODEL') ?? 'gpt-5.4',
      gemini: read('AI_DEFAULT_GEMINI_MODEL') ?? 'gemini-3.8-flash',
    },
    voyageApiKey: read('VOYAGE_API_KEY'),
    embeddingModel: read('EMBEDDING_MODEL') ?? 'voyage-3.5',
    cronSecret: read('CRON_SECRET'),
    n8nWebhookSecret: read('N8N_WEBHOOK_SECRET'),
    n8nBaseUrl: read('N8N_BASE_URL'),
    webPush:
      read('WEB_PUSH_PUBLIC_KEY') && read('WEB_PUSH_PRIVATE_KEY') && read('WEB_PUSH_SUBJECT')
        ? { publicKey: read('WEB_PUSH_PUBLIC_KEY')!, privateKey: read('WEB_PUSH_PRIVATE_KEY')!, subject: read('WEB_PUSH_SUBJECT')! }
        : null,
    workerId: `${read('HOSTNAME') ?? 'local'}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`,
  };
  return cached;
}

/** For tests that change process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}
