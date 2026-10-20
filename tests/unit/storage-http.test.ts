import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseByteRange, storageSignature, validStorageSignature } from '../../api/storage.js';

describe('storage HTTP semantics', () => {
  const previousSecret = process.env.STORAGE_SIGNING_SECRET;

  beforeEach(() => { process.env.STORAGE_SIGNING_SECRET = 'test-signing-secret-that-is-long-and-private'; });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.STORAGE_SIGNING_SECRET;
    else process.env.STORAGE_SIGNING_SECRET = previousSecret;
  });

  it('parses bounded, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-200', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects malformed and unsatisfiable ranges', () => {
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=20-10', 100)).toBeNull();
    expect(parseByteRange('bytes=100-', 100)).toBeNull();
    expect(parseByteRange('bytes=-0', 100)).toBeNull();
    expect(parseByteRange('bytes=0-0', 0)).toBeNull();
  });

  it('accepts an unexpired URL and rejects expiry or tampering', () => {
    const expires = 2_000;
    const signature = storageSignature('drive', 'workspace/private.docx', expires);
    const url = new URL(`https://example.test/file?expires=${expires}&signature=${signature}`);
    expect(validStorageSignature(url, 'drive', 'workspace/private.docx', 1_999)).toBe(true);
    expect(validStorageSignature(url, 'drive', 'workspace/private.docx', 2_000)).toBe(false);
    expect(validStorageSignature(url, 'drive', 'workspace/other.docx', 1_999)).toBe(false);
    url.searchParams.set('signature', `${signature}x`);
    expect(validStorageSignature(url, 'drive', 'workspace/private.docx', 1_999)).toBe(false);
  });
});
