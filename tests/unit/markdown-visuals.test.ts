import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/components/ui/Markdown/Markdown';
import { parseChart, parseStats, statusTone } from '../../src/components/ui/Markdown/Visuals';

const render = (text: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Markdown, { text })));

describe('visual agent answers', () => {
  it('draws chart and stats blocks instead of code', () => {
    const html = render([
      '**12 repositories, 4 already projects**',
      '```stats',
      '[{"label":"Repositories","value":30},{"label":"Projects","value":4,"tone":"good"}]',
      '```',
      '```chart',
      '{"type":"bar","title":"Open issues","data":[{"label":"b.rent","value":7},{"label":"autosav","value":3}]}',
      '```',
      '```chart',
      '{"type":"pie","title":"Share","data":[{"label":"Done","value":3},{"label":"Open","value":1}]}',
      '```',
    ].join('\n'));
    expect(html).not.toContain('<pre>');
    expect(html).toContain('Repositories');
    expect(html).toContain('Open issues');
    expect(html).toContain('<svg');
    expect(html).toContain('75%');
  });

  it('falls back to code for malformed blocks and keeps other code as code', () => {
    expect(render('```chart\nnot json\n```')).toContain('<pre>');
    expect(render('```ts\nconst a = 1;\n```')).toContain('const a = 1;');
    expect(parseChart('{"data":[]}')).toBeNull();
    expect(parseStats('[]')).toBeNull();
  });

  it('turns status cells into pills and tones callouts', () => {
    const html = render('| Repo | Status |\n|---|---|\n| b.rent | In progress |\n| autosav | Blocked |\n\n> ⚠️ Two repos have no tasks');
    expect(html).toContain('data-tone="info"');
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain('<blockquote data-tone="warn"');
    expect(statusTone('✅ Done')).toBe('good');
    expect(statusTone('b.rent')).toBeNull();
  });
});
