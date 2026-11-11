import { describe, expect, it } from 'vitest';
import { linkToken, officeCapability, officeType, readLinkToken, signJwt, verifyJwt } from '../../server/office.js';

const secret = 'test-office-secret-0123456789abcdef';

describe('ONLYOFFICE signing', () => {
  it('round-trips signed configs and rejects tampering or the wrong secret', () => {
    const token = signJwt({ document: { key: 'v1' } }, secret);
    expect(verifyJwt<{ document: { key: string } }>(token, secret)?.document.key).toBe('v1');
    const [head, , sig] = token.split('.');
    const forged = `${head}.${Buffer.from(JSON.stringify({ document: { key: 'v2' } })).toString('base64url')}.${sig}`;
    expect(verifyJwt(forged, secret)).toBeNull();
    expect(verifyJwt(token, 'another-secret')).toBeNull();
  });

  it('rejects expired tokens and alg downgrades', () => {
    expect(verifyJwt(signJwt({ exp: Math.floor(Date.now() / 1000) - 10 }, secret), secret)).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`;
    expect(verifyJwt(none, secret)).toBeNull();
  });

  it('keeps file and callback links separate from editor configs', () => {
    const link = linkToken({ purpose: 'file', item: 'i', version: 'v', user: 'u' }, secret);
    expect(readLinkToken(link, 'file', secret).item).toBe('i');
    expect(() => readLinkToken(link, 'callback', secret)).toThrow();
    // A config signed for the Document Server is not a valid link.
    expect(() => readLinkToken(signJwt({ purpose: 'file', item: 'i', version: 'v', user: 'u' }, secret), 'file', secret)).toThrow();
    expect(() => readLinkToken(null, 'file', secret)).toThrow();
  });

  it('opens modern Office formats for editing and legacy ones read-only', () => {
    expect(officeType('docx')).toEqual({ type: 'word', editable: true });
    expect(officeType('xlsx')).toEqual({ type: 'cell', editable: true });
    expect(officeType('pptx')).toEqual({ type: 'slide', editable: true });
    expect(officeType('doc')?.editable).toBe(false);
    expect(officeType('pdf')).toEqual({ type: 'pdf', editable: false, fillable: true });
    expect(officeType('exe')).toBeNull();
  });

  it('limits PDF writers to form filling and keeps viewers read-only', () => {
    expect(officeCapability('pdf', 'owner')).toBe('fill');
    expect(officeCapability('pdf', 'editor')).toBe('fill');
    expect(officeCapability('pdf', 'commenter')).toBe('view');
    expect(officeCapability('pdf', 'viewer')).toBe('view');
    expect(officeCapability('docx', 'editor')).toBe('edit');
    expect(officeCapability('doc', 'owner')).toBe('view');
  });
});
