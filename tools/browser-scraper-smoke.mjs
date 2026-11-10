import { readFileSync } from 'node:fs';

const baseUrl = (process.env.CRAWL4AI_URL ?? 'http://host.docker.internal:11235').replace(/\/$/, '');
const token = process.env.CRAWL4AI_API_TOKEN?.trim()
  || readFileSync(process.env.CRAWL4AI_API_TOKEN_FILE ?? '/run/browser-scraper/api_token', 'utf8').trim();
const target = process.env.CRAWL4AI_SMOKE_URL ?? 'https://example.com/';

if (!token) throw new Error('Crawl4AI token is empty.');

const headers = {
  accept: 'application/json',
  authorization: `Bearer ${token}`,
};

const schema = await fetch(`${baseUrl}/schema`, {
  headers,
  redirect: 'error',
  signal: AbortSignal.timeout(5_000),
});
await schema.body?.cancel();
if (!schema.ok) throw new Error(`Authenticated Crawl4AI readiness failed with HTTP ${schema.status}.`);

const scrape = await fetch(`${baseUrl}/md`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ url: target, f: 'fit' }),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!scrape.ok) {
  await scrape.body?.cancel();
  throw new Error(`Crawl4AI smoke scrape failed with HTTP ${scrape.status}.`);
}

const result = await scrape.json();
const markdown = typeof result === 'string' ? result : result?.markdown;
if (typeof markdown !== 'string' || markdown.trim().length === 0) {
  throw new Error('Crawl4AI smoke scrape returned no Markdown.');
}

console.log(`Crawl4AI authenticated smoke scrape passed (${markdown.length} Markdown characters from ${new URL(target).hostname}).`);
