import { describe, expect, it } from 'vitest';
import { AgnoRunError } from '../../server/agents/agno.js';
import { ProviderError } from '../../server/ai/provider.js';
import { errorMessage, providerDetail } from '../../server/agents/engine.js';

describe('agent run error messages', () => {
  it('explains model access problems instead of a generic server error', () => {
    const r = errorMessage(new AgnoRunError('The model `gpt-6.1-sol` does not exist or you do not have access to it.'));
    expect(r.code).toBe('model_unavailable');
    expect(r.message).toContain('API selector');
    expect(r.message).toContain('gpt-6.1-sol');
  });

  it('separates billing problems from rate limits', () => {
    const r = errorMessage(new AgnoRunError('You exceeded your current quota, please check your plan and billing details.'));
    expect(r.code).toBe('provider_billing');
    expect(errorMessage(new AgnoRunError('Rate limit reached for gpt-6.1-sol')).code).toBe('rate_limited');
  });

  it('shows other provider errors with their message', () => {
    const r = errorMessage(new AgnoRunError("Invalid schema for function 'search_crm': array schema missing items."));
    expect(r).toEqual({ code: 'provider_error', message: "The AI provider returned an error: Invalid schema for function 'search_crm': array schema missing items." });
  });

  it('keeps internal errors generic', () => {
    expect(errorMessage(new Error('relation "x" does not exist')).code).toBe('internal');
  });

  it('preserves actionable native OpenAI errors', () => {
    expect(errorMessage(new ProviderError('auth', 'OpenAI rejected the server credentials.'))).toEqual({
      code: 'auth', message: 'OpenAI rejected the configured credentials.',
    });
    expect(errorMessage(new ProviderError('unavailable', 'Could not reach OpenAI.'))).toEqual({
      code: 'provider_error', message: 'Could not reach OpenAI.',
    });
  });

  it('never shows key-like tokens', () => {
    const detail = providerDetail('Incorrect API key provided: sk-proj-abcdefghijklmnop. Bearer abc.def');
    expect(detail).not.toContain('sk-proj-abcdefghijklmnop');
    expect(detail).not.toContain('abc.def');
  });
});
