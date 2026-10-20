// Provider routing, startup configuration checks, rate limiting and the n8n
// signature / callback rules. Pure functions: no database or network.
import { afterEach, describe, expect, it } from 'vitest';
import { platformDefaultModel, providerNameFor } from '../../server/ai/registry.js';
import { resetEnvCache } from '../../server/env.js';
import { checkEnv } from '../../server/startup.js';
import { providerApiKey } from '../../server/provider-secrets.js';
import { clientAddress, limitFor, RateLimiter } from '../../server/rate-limit.js';
import { checkCallbackUrl, sign } from '../../server/integrations/n8n.js';

const VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API', 'AI_DEFAULT_PROVIDER', 'AI_DEFAULT_ANTHROPIC_MODEL', 'AI_DEFAULT_OPENAI_MODEL', 'AI_DEFAULT_GEMINI_MODEL',
  'DATABASE_URL', 'DATABASE_REST_URL', 'APP_JWT_SECRET', 'N8N_BASE_URL', 'VITE_OPENAI_API_KEY', 'VITE_GEMINI_API_KEY', 'VITE_GEMINI_API'];
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
function setEnv(vars: Record<string, string | undefined>) {
  for (const v of VARS) delete process.env[v];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  resetEnvCache();
}
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  resetEnvCache();
});

describe('provider routing', () => {
  it('derives the provider from the model id', () => {
    expect(providerNameFor('claude-opus-5-5')).toBe('anthropic');
    expect(providerNameFor('gpt-5.4-mini')).toBe('openai');
    expect(providerNameFor('o4-mini')).toBe('openai');
    expect(providerNameFor('gemini-3.8-flash')).toBe('gemini');
    expect(providerNameFor('llama3')).toBeNull();
  });

  it('defaults new workspaces to the configured provider', () => {
    setEnv({ OPENAI_API_KEY: 'sk', AI_DEFAULT_PROVIDER: 'anthropic' });
    expect(platformDefaultModel()).toBe('gpt-5.4');
    setEnv({ OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'sk', AI_DEFAULT_PROVIDER: 'openai', AI_DEFAULT_OPENAI_MODEL: 'gpt-5.6-sol' });
    expect(platformDefaultModel()).toBe('gpt-5.6-sol');
    setEnv({ ANTHROPIC_API_KEY: 'sk' });
    expect(platformDefaultModel()).toBe('claude-opus-5-5');
    setEnv({ GEMINI_API: 'AIza-compatibility-key', AI_DEFAULT_PROVIDER: 'gemini' });
    expect(providerApiKey('gemini')).toBe('AIza-compatibility-key');
    expect(platformDefaultModel()).toBe('gemini-3.8-flash');
  });
});

describe('startup configuration', () => {
  const base = { DATABASE_URL: 'postgresql://postgres:secret@db:5432/postgres', DATABASE_REST_URL: 'http://rest:3000', APP_JWT_SECRET: 'x'.repeat(32) };
  it('accepts a minimal valid configuration and warns without AI keys', () => {
    setEnv(base);
    const problems = checkEnv();
    expect(problems.filter((p) => p.level === 'fatal')).toEqual([]);
    expect(problems.some((p) => p.message.includes('No AI provider key'))).toBe(true);
  });
  it('rejects missing database settings, bad provider names and browser-exposed secrets', () => {
    setEnv({ AI_DEFAULT_PROVIDER: 'ollama', AI_DEFAULT_OPENAI_MODEL: 'claude-opus-5-5', VITE_OPENAI_API_KEY: 'sk' });
    const fatal = checkEnv().filter((p) => p.level === 'fatal').map((p) => p.message).join('\n');
    expect(fatal).toContain('DATABASE_URL');
    expect(fatal).toContain('APP_JWT_SECRET');
    expect(fatal).toContain('AI_DEFAULT_PROVIDER');
    expect(fatal).toContain('AI_DEFAULT_OPENAI_MODEL');
    expect(fatal).toContain('VITE_OPENAI_API_KEY');
  });
});

describe('rate limiting', () => {
  it('limits per client and window, and never limits probes', () => {
    const limiter = new RateLimiter();
    const t = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    for (let i = 0; i < 3; i++) expect(limiter.hit('start:1.2.3.4', 3, t + i)).toBe(0);
    expect(limiter.hit('start:1.2.3.4', 3, t + 10_000)).toBe(50);
    expect(limiter.hit('start:5.6.7.8', 3, t + 10_000)).toBe(0);
    expect(limiter.hit('start:1.2.3.4', 3, t + 60_000)).toBe(0);
    expect(limitFor('GET', '/api/ready')).toBeNull();
    expect(limitFor('POST', '/api/agents/run')?.bucket).toBe('start');
    expect(limitFor('GET', '/api/ai/status')?.bucket).toBe('general');
    // Traefik appended the client, Nginx appended Traefik.
    expect(clientAddress('203.0.113.9, 10.0.0.2', '10.0.0.3')).toBe('203.0.113.9');
    // A forged leading entry is ignored.
    expect(clientAddress('6.6.6.6, 203.0.113.9, 10.0.0.2', '10.0.0.3')).toBe('203.0.113.9');
    // Only one proxy in front (local Nginx): its single entry is the client.
    expect(clientAddress('198.51.100.4', '10.0.0.3')).toBe('198.51.100.4');
    expect(clientAddress(undefined, '10.0.0.3')).toBe('10.0.0.3');
  });
});

describe('n8n signatures and callbacks', () => {
  it('signs timestamp, method, path and body', () => {
    const s = sign('k'.repeat(64), '1760000000', 'post', '/api/integrations/n8n/runs', '{"a":1}');
    expect(s).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(sign('k'.repeat(64), '1760000000', 'POST', '/api/integrations/n8n/runs', '{"a":1}')).toBe(s);
    expect(sign('k'.repeat(64), '1760000001', 'POST', '/api/integrations/n8n/runs', '{"a":1}')).not.toBe(s);
    expect(sign('k'.repeat(64), '1760000000', 'POST', '/api/integrations/n8n/runs', '{"a":2}')).not.toBe(s);
  });
  it('only allows callbacks to the configured n8n host', () => {
    setEnv({ N8N_BASE_URL: 'https://n8n.digitalromanian.com' });
    expect(checkCallbackUrl('https://n8n.digitalromanian.com/webhook/abc')).toBe('https://n8n.digitalromanian.com/webhook/abc');
    expect(checkCallbackUrl(null)).toBeNull();
    expect(() => checkCallbackUrl('https://evil.example/webhook')).toThrow(/n8n.digitalromanian.com/);
    expect(() => checkCallbackUrl('http://n8n.digitalromanian.com/webhook')).toThrow();
    expect(() => checkCallbackUrl('https://user:pw@n8n.digitalromanian.com/webhook')).toThrow();
    setEnv({});
    expect(() => checkCallbackUrl('https://n8n.digitalromanian.com/webhook/abc')).toThrow(/disabled/);
  });
});
