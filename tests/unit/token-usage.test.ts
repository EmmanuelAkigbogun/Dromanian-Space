import { describe, expect, it } from 'vitest';
import { parseTokenLimit, tokenUsagePresentation } from '../../src/app/routes/Agents/tokenUsage.js';

describe('token usage presentation', () => {
  it('never invents a percentage or maximum when no limit is configured', () => {
    expect(tokenUsagePresentation(24_946, null)).toEqual({
      used: 24_946,
      limit: null,
      percentage: null,
      visualPercentage: null,
      tone: 'normal',
    });
  });

  it('uses the real configured limit and surfaces warning and exceeded states', () => {
    expect(tokenUsagePresentation(80_000, 100_000)).toMatchObject({ percentage: 80, visualPercentage: 80, tone: 'warning' });
    expect(tokenUsagePresentation(125_000, 100_000)).toMatchObject({ percentage: 125, visualPercentage: 100, tone: 'exceeded' });
  });

  it('normalizes invalid ledger values without turning them into a fake cap', () => {
    expect(tokenUsagePresentation(-12, 0)).toMatchObject({ used: 0, limit: null });
    expect(tokenUsagePresentation(Number.NaN, null)).toMatchObject({ used: 0, limit: null });
  });

  it('parses optional administrator limits without accepting decimals or unsafe values', () => {
    expect(parseTokenLimit('')).toBeNull();
    expect(parseTokenLimit(' 100000 ')).toBe(100_000);
    expect(() => parseTokenLimit('1.5')).toThrow(/whole numbers/);
    expect(() => parseTokenLimit('9007199254740992')).toThrow(/whole numbers/);
  });
});
