// GET /api/health — liveness and configuration presence (never values).
import { env } from '../server/env.js';
import { json } from '../server/http.js';
import { providerStates } from '../server/ai/registry.js';
import { serviceClient } from '../server/supabase.js';

export async function GET(): Promise<Response> {
  const e = env();
  let database: 'reachable' | 'unreachable' | 'not_configured' = 'not_configured';
  if (e.supabaseUrl && e.supabaseSecretKey) {
    const { error } = await serviceClient().from('agent_templates').select('key', { head: true, count: 'exact' }).limit(1);
    database = error ? 'unreachable' : 'reachable';
  }
  const providers = providerStates();
  return json({
    ok: database === 'reachable',
    database,
    ai_provider_configured: providers.some((p) => p.configured),
    ai_providers: Object.fromEntries(providers.map((p) => [p.name, p.configured])),
    embeddings_configured: Boolean(e.voyageApiKey),
    cron_secret_configured: Boolean(e.cronSecret),
    automation: { callbacks_enabled: Boolean(e.n8nBaseUrl) },
    time: new Date().toISOString(),
  });
}
