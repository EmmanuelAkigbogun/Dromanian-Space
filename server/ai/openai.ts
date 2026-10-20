import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  Tool,
  WebSearchTool,
} from 'openai/resources/responses/responses';
import { env } from '../env.js';
import {
  ProviderError,
  type Effort,
  type ModelProvider,
  type ModelSession,
  type SessionInput,
  type TurnCallbacks,
  type TurnResult,
  type TurnStop,
  type TurnUsage,
  type WebSource,
} from './provider.js';

// OpenAI Responses API adapter. Requests are stateless (store: false): the
// session keeps the full item list, including encrypted reasoning items, and
// sends it back each turn, so nothing depends on OpenAI-side conversation
// state and a run restarted on another worker behaves the same.

type OpenAIEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Reasoning models take `reasoning.effort`; older chat models reject it. */
export function reasoningEffortFor(model: string, effort: Effort): OpenAIEffort | null {
  if (!/^(gpt-5|o\d)/.test(model)) return null;
  // xhigh is accepted from gpt-5.2 on; earlier reasoning models stop at high.
  const extended = /^gpt-5\.([2-9]|\d{2,})/.test(model);
  if (effort === 'max' || effort === 'xhigh') return extended ? 'xhigh' : 'high';
  return effort;
}

let client: OpenAI | null = null;
let clientConfiguration: string | null = null;
let clientInjectedForTests = false;
function getClient(): OpenAI {
  const e = env();
  if (!e.openaiApiKey) throw new ProviderError('not_configured', 'OpenAI is not configured on the server (OPENAI_API_KEY).');
  const configuration = JSON.stringify([e.openaiApiKey, e.openaiBaseUrl, e.openaiOrganization, e.openaiProject]);
  if (!client || (!clientInjectedForTests && clientConfiguration !== configuration)) {
    client = new OpenAI({
      apiKey: e.openaiApiKey,
      baseURL: e.openaiBaseUrl ?? undefined,
      organization: e.openaiOrganization ?? undefined,
      project: e.openaiProject ?? undefined,
      maxRetries: 2,
      timeout: 10 * 60 * 1000,
    });
    clientConfiguration = configuration;
  }
  return client;
}

/** For tests: inject a client (for example one with a stubbed fetch). */
export function setOpenAIClientForTests(c: OpenAI | null): void {
  client = c;
  clientInjectedForTests = c !== null;
  clientConfiguration = null;
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('aborted', 'Stopped.');
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError('auth', 'OpenAI rejected the server credentials.');
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new ProviderError('model_unavailable', 'The configured model is not available to these OpenAI credentials.');
  }
  if (err instanceof OpenAI.RateLimitError) {
    // 429 also covers an exhausted quota; the message says which.
    const quota = /quota/i.test(err.message);
    return new ProviderError(
      'rate_limited',
      quota ? 'The OpenAI account has no remaining quota. Check billing for the API key.' : 'OpenAI is rate limiting requests. Try again in a minute.',
    );
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new ProviderError('bad_request', `OpenAI rejected the request${err.message ? `: ${err.message.slice(0, 200)}` : '.'}`);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError('unavailable', 'Could not reach OpenAI.');
  }
  if (err instanceof OpenAI.APIError) {
    return (err.status ?? 0) >= 500
      ? new ProviderError('overloaded', 'OpenAI is temporarily unavailable. Try again shortly.')
      : new ProviderError('bad_request', 'OpenAI returned an error.');
  }
  // A stream that ended with a `response.failed` / `error` event.
  if (err instanceof Error && /context|too long|maximum context/i.test(err.message)) {
    return new ProviderError('bad_request', 'The conversation is too long for the model; start a new conversation.');
  }
  return new ProviderError('unavailable', 'The OpenAI response failed before it completed.');
}

function usageOf(response: Response): TurnUsage {
  const u = response.usage;
  if (!u) return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  // OpenAI counts cached and cache-written tokens inside input_tokens; the
  // ledger stores them separately (as Anthropic reports them).
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: Math.max(0, u.input_tokens - cacheRead - cacheWrite),
    output_tokens: u.output_tokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

function parseArguments(raw: string): unknown {
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    // Fails the tool's schema check, so the engine reports INVALID_JSON and
    // never runs a truncated call.
    return { INVALID_JSON: raw.slice(0, 2000) };
  }
}

export function interpretResponse(response: Response): TurnResult {
  const output = response.output ?? [];
  let text = '';
  let refused = false;
  const toolCalls: TurnResult['toolCalls'] = [];
  const webSources: WebSource[] = [];
  const webSearches: string[] = [];
  const seen = new Set<string>();
  const addSource = (url: string, title: string | null) => {
    if (seen.has(url)) return;
    seen.add(url);
    webSources.push({ url, title });
  };

  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          text += part.text;
          for (const a of part.annotations ?? []) {
            if (a.type === 'url_citation') addSource(a.url, a.title ?? null);
          }
        } else if (part.type === 'refusal') {
          refused = true;
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    } else if (item.type === 'web_search_call') {
      const action = item.action;
      if (action?.type === 'search') {
        const queries = action.queries?.length ? action.queries : action.query ? [action.query] : [];
        webSearches.push(...queries);
        for (const s of action.sources ?? []) addSource(s.url, null);
      }
    }
  }

  let stop: TurnStop;
  const reason = response.incomplete_details?.reason;
  if (refused || reason === 'content_filter') stop = 'refusal';
  else if (reason === 'max_output_tokens') stop = 'max_tokens';
  else if (toolCalls.length > 0) stop = 'tool_use';
  else if (response.status === 'completed') stop = 'end';
  else stop = 'other';

  return {
    text,
    toolCalls,
    stop,
    refusalCategory: stop === 'refusal' ? (reason === 'content_filter' ? 'content_filter' : null) : null,
    usage: usageOf(response),
    model: response.model,
    fallbackUsed: false,
    webSearches,
    webSources,
  };
}

class OpenAISession implements ModelSession {
  private readonly items: ResponseInputItem[] = [];
  private readonly tools: Tool[];
  private readonly input: SessionInput;

  constructor(input: SessionInput) {
    this.input = input;
    for (const turn of input.history) this.items.push({ role: turn.role, content: turn.text });
    this.items.push({ role: 'user', content: input.userMessage });
    this.tools = input.tools.map(
      (t): FunctionTool => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        // The engine validates every call against its zod schema; strict mode
        // would require rewriting optional fields as nullable.
        strict: false,
      }),
    );
    // OpenAI has no separate page-fetch tool: a domain-filtered web search
    // covers "read pages of the configured site". General web research, when
    // enabled, is unfiltered.
    if (input.webSearch) {
      this.tools.push({ type: 'web_search' } satisfies WebSearchTool);
    } else if (input.webFetch && input.webFetch.allowedDomains.length > 0) {
      this.tools.push({ type: 'web_search', filters: { allowed_domains: input.webFetch.allowedDomains } } satisfies WebSearchTool);
    }
  }

  async next(cb: TurnCallbacks): Promise<TurnResult> {
    const openai = getClient();
    const effort = reasoningEffortFor(this.input.model, this.input.effort);
    let response: Response;
    try {
      const stream = openai.responses.stream(
        {
          model: this.input.model,
          instructions: this.input.system,
          input: this.items,
          max_output_tokens: this.input.maxTokens,
          store: false,
          ...(this.tools.length > 0 ? { tools: this.tools, parallel_tool_calls: true } : {}),
          ...(effort ? { reasoning: { effort }, include: ['reasoning.encrypted_content' as const] } : {}),
        },
        { signal: cb.signal },
      );
      stream.on('response.output_text.delta', (event) => cb.onText(event.delta));
      stream.on('response.output_item.done', (event) => {
        const item = event.item;
        if (item.type === 'web_search_call' && item.action?.type === 'search') {
          const q = item.action.queries?.[0] ?? item.action.query;
          if (q) cb.onWebSearch?.(q);
        }
      });
      response = await stream.finalResponse();
    } catch (err) {
      throw mapError(err);
    }
    if (response.status === 'failed') {
      throw mapError(new Error(response.error?.message ?? 'failed'));
    }

    const result = interpretResponse(response);
    // Append-only transcript: every output item (reasoning included) goes
    // back unchanged so the next turn continues it.
    if (result.stop === 'tool_use') {
      for (const item of response.output as ResponseOutputItem[]) this.items.push(item as ResponseInputItem);
    }
    return result;
  }

  addToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): void {
    for (const r of results) {
      this.items.push({
        type: 'function_call_output',
        call_id: r.id,
        output: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }
}

export const openaiProvider: ModelProvider = {
  name: 'openai',
  configured: () => Boolean(env().openaiApiKey),
  startSession: (input) => new OpenAISession(input),
};
