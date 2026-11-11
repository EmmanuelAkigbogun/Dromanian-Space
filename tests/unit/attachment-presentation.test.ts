import { describe, expect, it } from 'vitest';
import { isPdfFile } from '../../src/lib/message/attachmentType.js';

describe('attachment presentation', () => {
  it('recognizes a PDF from its MIME type', () => {
    expect(isPdfFile('application/pdf', 'document')).toBe(true);
  });

  it('recognizes a PDF extension when a browser reports a generic MIME type', () => {
    expect(isPdfFile('application/octet-stream', 'Quarterly Report.PDF')).toBe(true);
  });

  it('does not classify unrelated files as PDFs', () => {
    expect(isPdfFile('text/plain', 'notes.txt')).toBe(false);
  });
});
