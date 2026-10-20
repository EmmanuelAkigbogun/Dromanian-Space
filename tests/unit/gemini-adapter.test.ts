import type { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiModelCandidates, geminiProvider, setGeminiClientForTests } from '../../server/ai/gemini.js';
import { ProviderError, type SessionInput } from '../../server/ai/provider.js';

const input: SessionInput = {
  model: 'gemini-3.8-flash',
  effort: 'medium',
  system: 'Be concise.',
  history: [],
  userMessage: 'Hello',
  tools: [],
  webSearch: null,
  webFetch: null,
  maxTokens: 512,
};

function successfulStream(model: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { event_type: 'interaction.created', interaction: { model, status: 'in_progress' } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hello from Gemini' } };
      yield {
        event_type: 'interaction.completed',
        interaction: { model, status: 'completed', usage: { total_input_tokens: 8, total_output_tokens: 4 } },
      };
    },
  };
}

afterEach(() => setGeminiClientForTests(null));

describe('Gemini adapter', () => {
  it('keeps fallbacks on supported Gemini Flash models', () => {
    expect(geminiModelCandidates('gemini-3.8-flash')).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(geminiModelCandidates('gemini-3.6-flash')).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  });

  it('falls back to another Gemini model when the requested model is overloaded', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new ProviderError('overloaded', 'busy'))
      .mockResolvedValueOnce(successfulStream('gemini-3.6-flash'));
    setGeminiClientForTests({ interactions: { create } } as unknown as GoogleGenAI);
    const deltas: string[] = [];

    const result = await geminiProvider.startSession(input).next({
      signal: new AbortController().signal,
      onText: (delta) => deltas.push(delta),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map(([request]) => request.model)).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
    expect(result).toMatchObject({ text: 'Hello from Gemini', model: 'gemini-3.6-flash', fallbackUsed: true, stop: 'end' });
    expect(deltas).toEqual(['Hello from Gemini']);
  });

  it('does not replay a request after streamed output has become visible', async () => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Partial' } };
        throw new ProviderError('overloaded', 'lost after output');
      },
    });
    setGeminiClientForTests({ interactions: { create } } as unknown as GoogleGenAI);

    await expect(geminiProvider.startSession(input).next({
      signal: new AbortController().signal,
      onText: () => undefined,
    })).rejects.toMatchObject({ code: 'overloaded' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
