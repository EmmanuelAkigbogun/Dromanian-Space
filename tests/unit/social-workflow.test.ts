import { describe, expect, it } from 'vitest';
import { prefilledAgentBrief } from '../../src/app/routes/Agents/agentDeepLink.js';
import {
  buildCampaignBrief,
  calendarDays,
  creativePackageMarkdown,
  localDayKey,
  normalizeHashtagInput,
  socialAgentHref,
} from '../../src/app/routes/Social/socialWorkflow.js';

describe('company Social workflow helpers', () => {
  it('builds a company-bound review-only agent brief', () => {
    const brief = buildCampaignBrief({
      company: 'Acme Romania',
      goal: 'Launch the winter range',
      from: '2026-11-15',
      to: '2026-12-15',
      channels: ['LinkedIn', 'Instagram'],
      frequency: '3 posts per week',
      notes: 'Use the approved offer only',
    });

    expect(brief).toContain('Acme Romania');
    expect(brief).toContain('2026-11-15 through 2026-12-15');
    expect(brief).toContain('LinkedIn, Instagram');
    expect(brief).toContain('Drive/Brand kit');
    expect(brief).toContain('Social drafts only');
    expect(brief).toContain('Do not schedule or publish');
  });

  it('creates a bounded, decoded prefill without an auto-send signal', () => {
    const href = socialAgentHref('agent/one', 'company-one', `  ${'a'.repeat(4_000)}  `);
    const url = new URL(href, 'https://darkspace.example');

    expect(url.pathname).toBe('/agents/agent%2Fone');
    expect(url.searchParams.get('company')).toBe('company-one');
    expect(url.searchParams.has('send')).toBe(false);
    expect(prefilledAgentBrief(url.searchParams.get('brief'))).toHaveLength(3_500);
    expect(prefilledAgentBrief('  Ask for review  ')).toBe('Ask for review');
  });

  it('normalizes and deduplicates hashtags', () => {
    expect(normalizeHashtagInput('#launch, launch  ##Romania   brand')).toEqual([
      'launch', 'Romania', 'brand',
    ]);
  });

  it('exports a truthful creative handoff with canonical Drive references', () => {
    const markdown = creativePackageMarkdown({
      company: 'Acme Romania',
      channel: 'linkedin',
      format: 'carousel',
      caption: 'A useful caption',
      script: 'Slide one, slide two',
      visualBrief: 'Use the approved blue palette',
      cta: 'Book a demo',
      hashtags: ['launch'],
      assets: [{ item_id: 'drive-asset-1', label: 'Primary logo.svg', mime_type: 'image/svg+xml' }],
    });

    expect(markdown).toContain('Primary logo.svg (Drive item: drive-asset-1; image/svg+xml)');
    expect(markdown).toContain('Book a demo');
    expect(markdown).toContain('#launch');
    expect(markdown).toContain('Export package only');
    expect(markdown).not.toContain('Canva design created');
  });

  it('builds a stable six-week Monday-first calendar', () => {
    const days = calendarDays(new Date(2026, 10, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(localDayKey(days[0])).toMatch(/^2026-\d{2}-\d{2}$/);
  });
});
