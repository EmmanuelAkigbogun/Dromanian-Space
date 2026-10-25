import { describe, expect, it } from 'vitest';
import { isPushEndpoint } from '../../server/push.js';

describe('push subscription endpoints', () => {
  it('accepts the push services browsers use', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAAA')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGx1')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('refuses anything the worker should not post to', () => {
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/fcm/send/x')).toBe(false);
    expect(isPushEndpoint('https://localhost/push')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isPushEndpoint('https://notify.windows.com.evil.example/x')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
  });
});
