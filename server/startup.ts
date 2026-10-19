// Startup checks shared by the API and the worker: configuration validation
// (fail fast on what cannot work), waiting for the database with backoff, and
// reporting which AI providers this server has keys for (booleans only).

import { env } from './env.js';
import { log } from './log.js';
import { platformDefaultModel, providerNameFor, providerStates } from './ai/registry.js';
import { rpc } from './database.js';

export interface EnvProblem {
  level: 'fatal' | 'warning';
  message: string;
}

export function checkEnv(): EnvProblem[] {
  const e = env();
  const problems: EnvProblem[] = [];
  const fatal = (message: string) => problems.push({ level: 'fatal', message });
  const warn = (message: string) => problems.push({ level: 'warning', message });

  if (!e.databaseUrl) fatal('DATABASE_URL is not set.');
  else if (!/^postgres(?:ql)?:\/\//.test(e.databaseUrl)) fatal('DATABASE_URL must be a PostgreSQL connection URL.');
  if (!/^https?:\/\//.test(e.databaseRestUrl)) fatal('DATABASE_REST_URL must start with http:// or https://.');
  if (!e.appJwtSecret || e.appJwtSecret.length < 32) fatal('APP_JWT_SECRET must contain at least 32 characters.');

  const raw = process.env.AI_DEFAULT_PROVIDER?.trim();
  if (raw && raw !== 'anthropic' && raw !== 'openai') fatal(`AI_DEFAULT_PROVIDER must be "anthropic" or "openai", not "${raw}".`);
  for (const [provider, model] of Object.entries(e.defaultModels)) {
    if (providerNameFor(model) !== provider) {
      fatal(`AI_DEFAULT_${provider.toUpperCase()}_MODEL "${model}" is not a ${provider} model id.`);
    }
  }
  const states = providerStates();
  if (!states.some((s) => s.configured)) {
    warn('No AI provider key is set (ANTHROPIC_API_KEY or OPENAI_API_KEY); agents will show a setup state.');
  } else if (!states.find((s) => s.name === e.defaultProvider)?.configured) {
    warn(`AI_DEFAULT_PROVIDER is ${e.defaultProvider} but its key is missing; new workspaces default to the configured provider.`);
  }
  if (e.n8nBaseUrl && !/^https?:\/\/[^/]+/.test(e.n8nBaseUrl)) fatal('N8N_BASE_URL must be an absolute http(s) URL.');
  for (const name of ['VITE_DATABASE_URL', 'VITE_APP_JWT_SECRET', 'VITE_ANTHROPIC_API_KEY', 'VITE_OPENAI_API_KEY']) {
    if (process.env[name]) fatal(`${name} must not exist: VITE_ variables are compiled into the browser bundle.`);
  }
  return problems;
}

/** Logs configuration problems; exits when any is fatal. */
export function enforceEnv(role: 'api' | 'worker'): void {
  const problems = checkEnv();
  for (const p of problems) (p.level === 'fatal' ? log.error : log.warn)('configuration', { role, problem: p.message });
  if (problems.some((p) => p.level === 'fatal')) {
    log.error('refusing to start with invalid configuration', { role });
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries until the database answers (exponential backoff, capped at 30 s). */
export async function waitForDatabase(maxWaitMs = 10 * 60_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      await rpc('system_readiness');
      if (attempt > 1) log.info('database reachable', { attempt });
      return true;
    } catch (err) {
      if (Date.now() + delay > deadline) {
        log.error('database still unreachable; giving up waiting', { attempt });
        return false;
      }
      log.warn('database not reachable yet', { attempt, retry_in_ms: delay, error: err instanceof Error ? err : String(err) });
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** Records which providers are configured and the platform default model. */
export async function reportPlatform(): Promise<void> {
  const providers = Object.fromEntries(providerStates().map((s) => [s.name, s.configured]));
  try {
    await rpc('ai_report_platform', { p_providers: providers, p_default_model: platformDefaultModel() });
  } catch (err) {
    // Before the provider migration is applied the function does not exist.
    log.warn('could not report AI provider state', { error: err instanceof Error ? err : String(err) });
  }
}
