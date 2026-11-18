import { describe, expect, it } from 'vitest';
import {
  candidates, domainOf, EMAIL_STATUS, findEmailsForDomain, nameParts, patternOf,
  type EmailResult, type FinderContact, type MailboxCheck,
} from '../../server/email-finder.js';

const signal = new AbortController().signal;

async function run(
  contacts: FinderContact[],
  opts: { published?: string[]; mailboxes?: string[]; catchAll?: boolean; verifier?: boolean; mx?: boolean; unknown?: boolean },
) {
  const results = new Map<string, EmailResult>();
  const probes: string[] = [];
  await findEmailsForDomain('firma.ro', contacts, {
    signal,
    probeDelayMs: 0,
    verifierAvailable: opts.verifier ?? true,
    hasMx: async () => opts.mx ?? true,
    published: async () => new Set(opts.published ?? []),
    check: async (email): Promise<MailboxCheck> => {
      probes.push(email);
      if (opts.unknown) return { reachable: 'unknown', catchAll: null, acceptsMail: true };
      if (opts.catchAll) return { reachable: 'risky', catchAll: true, acceptsMail: true };
      return { reachable: (opts.mailboxes ?? []).includes(email) ? 'safe' : 'invalid', catchAll: false, acceptsMail: true };
    },
    onResult: async (c, r) => { results.set(c.id, r); },
  });
  return { results, probes };
}

describe('names and candidates', () => {
  it('drops credentials, honorifics and diacritics', () => {
    expect(nameParts('Vergil Duruinu, EMBA')).toEqual(['vergil', 'duruinu']);
    expect(nameParts('Dr. Horatiu Lucian Iulian')).toEqual(['horatiu', 'lucian', 'iulian']);
    expect(nameParts('Ionel Rădulescu')).toEqual(['ionel', 'radulescu']);
    expect(nameParts('Csaba Szilágyi MRICS')).toEqual(['csaba', 'szilagyi']);
  });

  it('tries the natural reading before the reversed one, and hyphenated names', () => {
    const list = candidates('Anamaria-Ileana Lăzăroiu', 'firma.ro').map((c) => c.email);
    expect(list[0]).toBe('anamaria.lazaroiu@firma.ro');
    expect(list).toContain('anamariaileana.lazaroiu@firma.ro');
    expect(list).toContain('lazaroiu.anamaria@firma.ro');
    expect(new Set(list).size).toBe(list.length);
  });

  it('puts a known pattern first and recognises patterns', () => {
    expect(candidates('Sorin Greu', 'firma.ro', 'f.last')[0].email).toBe('s.greu@firma.ro');
    expect(patternOf('S.Greu@firma.ro', 'Sorin Greu', 'firma.ro')).toBe('f.last');
    expect(patternOf('office@firma.ro', 'Sorin Greu', 'firma.ro')).toBeNull();
    expect(candidates('Madonna', 'firma.ro')).toEqual([]);
  });

  it('reads a company domain from a website', () => {
    expect(domainOf('https://www.firma.ro/contact')).toBe('firma.ro');
    expect(domainOf('firma.ro')).toBe('firma.ro');
    expect(domainOf('')).toBeNull();
  });
});

describe('findEmailsForDomain', () => {
  const sorin = { id: '1', name: 'Sorin Greu' };
  const ana = { id: '2', name: 'Ana Popescu' };

  it('uses addresses published on the website without probing them', async () => {
    const { results } = await run([sorin], { published: ['sorin.greu@firma.ro', 'office@firma.ro'], mailboxes: [] });
    expect(results.get('1')).toMatchObject({ email: 'sorin.greu@firma.ro', status: EMAIL_STATUS.verified });
  });

  it('confirms mailboxes and reuses the pattern it learned', async () => {
    const { results, probes } = await run([sorin, ana], { mailboxes: ['s.greu@firma.ro', 'a.popescu@firma.ro'] });
    expect(results.get('1')).toMatchObject({ email: 's.greu@firma.ro', status: EMAIL_STATUS.verified });
    expect(results.get('2')).toMatchObject({ email: 'a.popescu@firma.ro', status: EMAIL_STATUS.verified });
    // catch-all probe + Sorin's search + Ana straight on the learned pattern
    expect(probes.filter((p) => p.endsWith('popescu@firma.ro') || p.includes('ana'))).toEqual(['a.popescu@firma.ro']);
  });

  it('never guesses on a catch-all domain without a published pattern', async () => {
    const { results, probes } = await run([sorin], { catchAll: true });
    expect(results.get('1')).toMatchObject({ email: null, status: EMAIL_STATUS.notFound });
    expect(probes).toHaveLength(1);
  });

  it('on a catch-all domain uses the pattern from the website as "likely"', async () => {
    const { results } = await run([sorin, ana], { catchAll: true, published: ['ana.popescu@firma.ro'] });
    expect(results.get('2')).toMatchObject({ status: EMAIL_STATUS.verified });
    expect(results.get('1')).toMatchObject({ email: 'sorin.greu@firma.ro', status: EMAIL_STATUS.likelyCatchAll });
  });

  it('reports servers that will not answer instead of guessing', async () => {
    const { results } = await run([sorin], { unknown: true });
    expect(results.get('1')).toMatchObject({ email: null, status: EMAIL_STATUS.unverifiable });
  });

  it('skips domains without a mail server', async () => {
    const { results, probes } = await run([sorin], { mx: false });
    expect(results.get('1')).toMatchObject({ email: null, status: EMAIL_STATUS.noMail });
    expect(probes).toHaveLength(0);
  });

  it('without the verifier, only marks pattern guesses as likely', async () => {
    const { results, probes } = await run([sorin, ana], { verifier: false, published: ['ana.popescu@firma.ro'] });
    expect(probes).toHaveLength(0);
    expect(results.get('1')).toMatchObject({ email: 'sorin.greu@firma.ro', status: EMAIL_STATUS.likelyPattern });
  });

  it('marks a not-found contact when no pattern exists', async () => {
    const { results } = await run([sorin], { mailboxes: [] });
    expect(results.get('1')).toMatchObject({ email: null, status: EMAIL_STATUS.notFound });
  });
});
