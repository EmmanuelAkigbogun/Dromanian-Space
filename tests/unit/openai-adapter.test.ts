// OpenAI adapter against a scripted Responses API stream (stubbed fetch).
// No network and no paid request: this is NOT evidence of a live OpenAI call.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { openaiProvider, reasoningEffortFor, setOpenAIClientForTests } from '../../server/ai/openai.js';
import { ProviderError, type SessionInput } from '../../server/ai/provider.js';
import { resetEnvCache } from '../../server/env.js';

type Json = Record<string, unknown>;

function sse(events: Json[]): Response {
  const body = events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function responseObject(output: Json[], extra: Json = {}): Json {
  return {
    id: 'resp_test', object: 'response', created_at: 1, model: 'gpt-5.4-2026-03-05', status: 'completed',
    output, parallel_tool_calls: true, tool_choice: 'auto', tools: [], error: null, incomplete_details: null,
    instructions: null, metadata: {}, temperature: 1, top_p: 1,
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 1280 },
    ...extra,
  };
}

/** A completed stream whose final snapshot is `final` (no incremental deltas needed). */
function completedStream(final: Json, textDeltas: string[] = []): Response {
  const events: Json[] = [{ type: 'response.created', response: { ...final, status: 'in_progress', output: [] } }];
  const output = final.output as Json[];
  output.forEach((item, i) => {
    if (item.type === 'message') {
      events.push({ type: 'response.output_item.added', output_index: i, item: { ...item, content: [] } });
      events.push({ type: 'response.content_part.added', output_index: i, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
      for (const d of textDeltas) events.push({ type: 'response.output_text.delta', output_index: i, content_index: 0, item_id: item.id, delta: d, logprobs: [] });
    } else {
      events.push({ type: 'response.output_item.added', output_index: i, item });
    }
    events.push({ type: 'response.output_item.done', output_index: i, item });
  });
  events.push({ type: final.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: final });
  return sse(events);
}

const requests: Json[] = [];
let script: Array<() => Response> = [];

function install() {
  const fetchStub = async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')));
    const next = script.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  };
  setOpenAIClientForTests(new OpenAI({ apiKey: 'sk-test', fetch: fetchStub as typeof fetch, maxRetries: 0 }));
}

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  model: 'gpt-5.4',
  effort: 'max',
  system: 'You are a test agent.',
  history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'earlier answer' }],
  userMessage: 'Read the policy.',
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } }],
  webSearch: null,
  webFetch: null,
  maxTokens: 32000,
  ...over,
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  resetEnvCache();
  requests.length = 0;
  script = [];
  install();
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  resetEnvCache();
  setOpenAIClientForTests(null);
});

describe('OpenAI provider adapter', () => {
  it('runs a tool loop statelessly and maps usage, citations and stop reasons', async () => {
    script.push(() =>
      completedStream(
        responseObject([
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"item_id":"abc"}', status: 'completed' },
        ]),
      ),
    );
    script.push(() =>
      completedStream(
        responseObject([
          {
            type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'The limit is EUR 180 [1].', annotations: [{ type: 'url_citation', url: 'https://example.com/p', title: 'Policy', start_index: 0, end_index: 3 }] }],
          },
        ]),
        ['The limit ', 'is EUR 180 [1].'],
      ),
    );

    const session = openaiProvider.startSession(input());
    const deltas: string[] = [];
    const signal = new AbortController().signal;
    const first = await session.next({ signal, onText: (d) => deltas.push(d) });
    expect(first.stop).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { item_id: 'abc' } }]);
    expect(first.usage).toEqual({ input_tokens: 1000, output_tokens: 80, cache_read_tokens: 200, cache_write_tokens: 0 });
    expect(first.model).toBe('gpt-5.4-2026-03-05');

    const req1 = requests[0];
    expect(req1.store).toBe(false);
    expect(req1.instructions).toBe('You are a test agent.');
    expect(req1.reasoning).toEqual({ effort: 'xhigh' });
    expect(req1.include).toEqual(['reasoning.encrypted_content']);
    expect(req1.max_output_tokens).toBe(32000);
    expect((req1.tools as Json[])[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false });
    expect(req1.input).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'Read the policy.' },
    ]);

    session.addToolResults([{ id: 'call_1', content: 'EUR 180 per night' }]);
    const second = await session.next({ signal, onText: (d) => deltas.push(d) });
    expect(second.stop).toBe('end');
    expect(second.text).toBe('The limit is EUR 180 [1].');
    expect(deltas.join('')).toBe('The limit is EUR 180 [1].');
    expect(second.webSources).toEqual([{ url: 'https://example.com/p', title: 'Policy' }]);

    // The second request replays reasoning and the call, then the tool output.
    const items = requests[1].input as Json[];
    expect(items.slice(3).map((i) => i.type)).toEqual(['reasoning', 'function_call', 'function_call_output']);
    expect(items[3].encrypted_content).toBe('enc-1');
    expect(items[5]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'EUR 180 per night' });
  });

  it('never runs a call with unreadable arguments and reports truncation', async () => {
    script.push(() =>
      completedStream(
        responseObject(
          [{ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read_file', arguments: '{"item_id": "ab', status: 'incomplete' }],
          { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        ),
      ),
    );
    const result = await openaiProvider.startSession(input()).next({ signal: new AbortController().signal, onText: () => undefined });
    expect(result.stop).toBe('max_tokens');
    expect(result.toolCalls[0].input).toEqual({ INVALID_JSON: '{"item_id": "ab' });
  });

  it('treats refusals and content filtering as refusals', async () => {
    script.push(() =>
      completedStream(responseObject([{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No.' }] }])),
    );
    const result = await openaiProvider.startSession(input({ tools: [] })).next({ signal: new AbortController().signal, onText: () => undefined });
    expect(result.stop).toBe('refusal');
    expect(requests[0].tools).toBeUndefined();
  });

  it('restricts site reading to the configured domain and enables general web search when allowed', async () => {
    const done = () => completedStream(responseObject([{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }]));
    script.push(done, done);
    await openaiProvider.startSession(input({ webFetch: { allowedDomains: ['example.com'], maxUses: 8 } })).next({ signal: new AbortController().signal, onText: () => undefined });
    await openaiProvider.startSession(input({ webSearch: { maxUses: 5 } })).next({ signal: new AbortController().signal, onText: () => undefined });
    expect((requests[0].tools as Json[]).at(-1)).toEqual({ type: 'web_search', filters: { allowed_domains: ['example.com'] } });
    expect((requests[1].tools as Json[]).at(-1)).toEqual({ type: 'web_search' });
  });

  it('maps API errors to clear provider errors', async () => {
    const error = (status: number, message: string) => () =>
      new Response(JSON.stringify({ error: { message, type: 'x', code: null, param: null } }), { status, headers: { 'content-type': 'application/json' } });
    const cases: Array<[number, string, string]> = [
      [401, 'bad key', 'auth'],
      [404, 'model not found', 'model_unavailable'],
      [429, 'Rate limit reached', 'rate_limited'],
      [400, 'Invalid parameter', 'bad_request'],
      [503, 'overloaded', 'overloaded'],
    ];
    for (const [status, message, code] of cases) {
      script.push(error(status, message));
      const err = await openaiProvider.startSession(input()).next({ signal: new AbortController().signal, onText: () => undefined }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }
  });

  it('reports cancellation as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    script.push(() => completedStream(responseObject([])));
    const err = await openaiProvider.startSession(input()).next({ signal: controller.signal, onText: () => undefined }).catch((e) => e);
    expect((err as ProviderError).code).toBe('aborted');
  });

  it('is unconfigured without a key', () => {
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();
    expect(openaiProvider.configured()).toBe(false);
  });
});

describe('reasoning effort mapping', () => {
  it('maps effort per model family', () => {
    expect(reasoningEffortFor('gpt-5.4', 'max')).toBe('xhigh');
    expect(reasoningEffortFor('gpt-5.6-sol', 'xhigh')).toBe('xhigh');
    expect(reasoningEffortFor('gpt-5', 'max')).toBe('high');
    expect(reasoningEffortFor('gpt-5.1', 'xhigh')).toBe('high');
    expect(reasoningEffortFor('o3', 'low')).toBe('low');
    expect(reasoningEffortFor('gpt-4.1', 'medium')).toBeNull();
  });
});
