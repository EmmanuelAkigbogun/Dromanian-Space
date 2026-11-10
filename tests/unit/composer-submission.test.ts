import { describe, expect, it } from 'vitest';
import {
  composerIsUnchanged,
  composerRouteKey,
  composerScopeIsCurrent,
  failedAttachmentItems,
  nextComposerScopeToken,
  withoutSubmittedItems,
} from '../../src/lib/composerSubmission.js';

describe('composer submission snapshots', () => {
  it('removes only the submitted attachments and preserves a later draft attachment', () => {
    const submitted = [{ id: 'sent' }];
    const current = [{ id: 'sent' }, { id: 'next' }];

    expect(withoutSubmittedItems(current, submitted)).toEqual([{ id: 'next' }]);
    expect(current).toEqual([{ id: 'sent' }, { id: 'next' }]);
    expect(submitted).toEqual([{ id: 'sent' }]);
  });

  it('restores a partially uploaded batch once while preserving later attachments', () => {
    const submitted = [
      { id: 'uploaded', path: 'agent-images/user/uploaded.png' },
      { id: 'failed', path: '' },
    ];
    const current = [
      { id: 'uploaded', path: '' },
      { id: 'next-draft', path: '' },
    ];

    expect([...submitted, ...withoutSubmittedItems(current, submitted)]).toEqual([
      { id: 'uploaded', path: 'agent-images/user/uploaded.png' },
      { id: 'failed', path: '' },
      { id: 'next-draft', path: '' },
    ]);
  });

  it('keeps a failed schedule snapshot retryable without replacing a later draft', () => {
    const failedSchedule = { revision: 7, content: 'send this tomorrow' };
    const laterDraft = { revision: 8, content: 'new message in progress' };

    expect(composerIsUnchanged(failedSchedule.revision, failedSchedule.revision)).toBe(true);
    expect(composerIsUnchanged(failedSchedule.revision, laterDraft.revision)).toBe(false);
    expect(failedSchedule.content).toBe('send this tomorrow');
    expect(laterDraft.content).toBe('new message in progress');
  });

  it('invalidates an old route token even after navigating back to the same conversation', () => {
    const routeA = composerRouteKey('channel-a', 'conversation-a', null);
    const routeB = composerRouteKey('channel-b', 'conversation-b', 'thread-b');
    const firstA = nextComposerScopeToken(null, routeA);

    expect(nextComposerScopeToken(firstA, routeA)).toBe(firstA);

    const atB = nextComposerScopeToken(firstA, routeB);
    const secondA = nextComposerScopeToken(atB, routeA);

    expect(composerScopeIsCurrent(firstA, secondA)).toBe(false);
    expect(composerScopeIsCurrent(secondA, secondA)).toBe(true);
  });

  it('retries only failed attachments and retains an uploaded path for create-only retry', () => {
    const uploaded = { id: 'uploaded', uploadedUrl: 'channel/uploaded.png' };
    const uploadFailed = { id: 'upload-failed' };
    const complete = { id: 'complete', uploadedUrl: 'channel/complete.png' };

    expect(failedAttachmentItems([
      { item: uploaded, succeeded: false },
      { item: uploadFailed, succeeded: false },
      { item: complete, succeeded: true },
    ])).toEqual([uploaded, uploadFailed]);
  });
});
