import { describe, expect, it } from 'vitest';
import { toolAvailability } from '../../server/agents/tools/index.js';

const configured = {
  webResearchEnabled: true,
  webResearchAvailable: true,
  browserScraperAvailable: true,
  crmInstalled: true,
  siteUrl: 'https://example.com',
  brandKitFolderId: null,
};

describe('agent tool readiness', () => {
  it('requires both the workspace switch and a healthy web runtime', () => {
    expect(toolAvailability(['web_search'], { ...configured, webResearchAvailable: false })[0]).toMatchObject({
      available: false,
      reason: expect.stringContaining('No web research runtime'),
    });
    expect(toolAvailability(['web_search'], { ...configured, webResearchEnabled: false })[0]).toMatchObject({
      available: false,
      reason: expect.stringContaining('turned off'),
    });
    expect(toolAvailability(['web_search'], configured)[0]).toMatchObject({ available: true });
  });

  it('reports site fetch ready only when the site and web runtime are ready', () => {
    expect(toolAvailability(['fetch_site_page'], { ...configured, siteUrl: null })[0]).toMatchObject({
      available: false,
      reason: expect.stringContaining('site address'),
    });
    expect(toolAvailability(['fetch_site_page'], configured)[0]).toMatchObject({ available: true });
  });

  it('requires both the workspace switch and the private browser runtime', () => {
    expect(toolAvailability(['browser_scrape'], { ...configured, browserScraperAvailable: false })[0]).toMatchObject({
      available: false,
      reason: expect.stringContaining('private browser scraper'),
    });
    expect(toolAvailability(['browser_scrape'], { ...configured, webResearchEnabled: false })[0]).toMatchObject({
      available: false,
      reason: expect.stringContaining('turned off'),
    });
    expect(toolAvailability(['browser_scrape'], configured)[0]).toMatchObject({ available: true });
  });

  it('marks Social draft creation as an approval-card action', () => {
    expect(toolAvailability(['propose_social_posts'], configured)[0]).toEqual({
      name: 'propose_social_posts',
      available: true,
      approval: 'review_card',
    });
  });
});
