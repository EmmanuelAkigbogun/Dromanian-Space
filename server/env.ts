// Server-only configuration. Nothing here may be exposed through a VITE_
// variable or imported by browser code.

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export interface ServerEnv {
  supabaseUrl: string | null;
  /** Secret (service role) key. Server jobs and API functions only. */
  supabaseSecretKey: string | null;
  anthropicApiKey: string | null;
  /** Server-side refusal fallback (`fallbacks: "default"`); on unless set to "off". */
  refusalFallback: boolean;
  voyageApiKey: string | null;
  embeddingModel: string;
  cronSecret: string | null;
  workerId: string;
}

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  cached = {
    supabaseUrl: read('SUPABASE_URL') ?? read('VITE_SUPABASE_URL'),
    supabaseSecretKey: read('SUPABASE_SECRET_KEY') ?? read('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicApiKey: read('ANTHROPIC_API_KEY'),
    refusalFallback: read('ANTHROPIC_REFUSAL_FALLBACK') !== 'off',
    voyageApiKey: read('VOYAGE_API_KEY'),
    embeddingModel: read('EMBEDDING_MODEL') ?? 'voyage-3.5',
    cronSecret: read('CRON_SECRET'),
    workerId: `${read('VERCEL_REGION') ?? 'local'}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`,
  };
  return cached;
}

/** For tests that change process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}
