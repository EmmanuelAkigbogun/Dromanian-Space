import { describe, expect, it } from 'vitest';
import { officeEditorError, officeEditorStatus } from '../../src/components/drive/OfficeEditor/officeEditorState.js';

describe('Office editor presentation state', () => {
  it('uses clear progress and permission-aware ready labels', () => {
    expect(officeEditorStatus('configuring', null)).toBe('Preparing secure editor…');
    expect(officeEditorStatus('loading', null)).toBe('Loading document editor…');
    expect(officeEditorStatus('opening', 'edit')).toBe('Opening document…');
    expect(officeEditorStatus('ready', 'edit')).toBe('Editing · changes save automatically');
    expect(officeEditorStatus('ready', 'fill')).toBe('Fill PDF form · changes save as new versions');
    expect(officeEditorStatus('ready', 'view')).toBe('View only');
    expect(officeEditorStatus('saving', 'fill')).toBe('Saving completed PDF as a new version…');
    expect(officeEditorStatus('saving', 'edit')).toBe('Saving changes…');
    expect(officeEditorStatus('failed', 'edit')).toBe('Editor unavailable');
  });

  it('normalizes ONLYOFFICE errors without trusting an assumed event shape', () => {
    expect(officeEditorError({ data: { errorCode: -4, errorDescription: 'Download failed' } }))
      .toBe('Download failed (error -4).');
    expect(officeEditorError({ data: { errorDescription: 'Unknown format' } })).toBe('Unknown format.');
    expect(officeEditorError({ data: { errorCode: 7 } })).toBe('The document editor reported error 7.');
    expect(officeEditorError(null)).toBe('The document editor could not open this file.');
  });
});
