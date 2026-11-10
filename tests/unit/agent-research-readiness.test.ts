import { describe, expect, it } from 'vitest';
import { coreResearchLimitation } from '../../src/app/routes/Agents/researchReadiness.js';

describe('agent public-research readiness', () => {
  it('marks the whole-team coordinator limited when every delegated research route is down', () => {
    expect(coreResearchLimitation(
      'cerebras_coordinator',
      ['web_search', 'browser_scrape', 'fetch_site_page'],
      [
        { name: 'web_search', available: false, reason: 'Provider search is unavailable.' },
        { name: 'browser_scrape', available: false, reason: 'Private scraper is unavailable.' },
        { name: 'fetch_site_page', available: false, reason: 'No site is configured.' },
      ],
    )).toContain('Public research is unavailable');
  });

  it('marks a research role limited when every assigned public tool is unavailable', () => {
    expect(coreResearchLimitation(
      'github_seo_specialist',
      ['web_search', 'browser_scrape'],
      [
        { name: 'web_search', available: false, reason: 'Web research is disabled.' },
        { name: 'browser_scrape', available: false, reason: 'Browser worker is offline.' },
      ],
    )).toContain('Public research is unavailable');
  });

  it('does not mark the role limited when at least one assigned public tool works', () => {
    expect(coreResearchLimitation(
      'cerebras_research',
      ['web_search', 'browser_scrape'],
      [
        { name: 'web_search', available: false },
        { name: 'browser_scrape', available: true },
      ],
    )).toBeNull();
  });

  it('does not turn an optional research tool into a core limitation for other roles', () => {
    expect(coreResearchLimitation(
      'github_project_manager',
      ['browser_scrape'],
      [{ name: 'browser_scrape', available: false }],
    )).toBeNull();
  });
});
