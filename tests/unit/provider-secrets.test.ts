import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProviderKey, sealProviderKey } from '../../server/provider-secrets.js';

describe('provider secret encryption', () => {
  const previous = process.env.APP_JWT_SECRET;

  beforeEach(() => { process.env.APP_JWT_SECRET = 'test-secret-that-is-at-least-thirty-two-characters'; });
  afterEach(() => {
    if (previous === undefined) delete process.env.APP_JWT_SECRET;
    else process.env.APP_JWT_SECRET = previous;
  });

  it('round-trips a key without storing it as plaintext', () => {
    const value = 'sk-ant-test-provider-secret-value';
    const sealed = sealProviderKey('anthropic', value);
    expect(JSON.stringify(sealed)).not.toContain(value);
    expect(openProviderKey('anthropic', sealed)).toBe(value);
  });

  it('binds ciphertext to its provider', () => {
    const sealed = sealProviderKey('anthropic', 'sk-ant-test-provider-secret-value');
    expect(() => openProviderKey('openai', sealed)).toThrow();
  });

  it('encrypts and decrypts Gemini keys without exposing plaintext', () => {
    const value = 'AIza-test-gemini-provider-secret-value';
    const sealed = sealProviderKey('gemini', value);
    expect(JSON.stringify(sealed)).not.toContain(value);
    expect(openProviderKey('gemini', sealed)).toBe(value);
  });
});
