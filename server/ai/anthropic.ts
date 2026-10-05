import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { env } from '../env.js';
import {
  ProviderError,
  type ModelProvider,
  type ModelSession,
  type SessionInput,
  type TurnCallbacks,
  type TurnResult,
  type TurnStop,
  type TurnUsage,
  type WebSource,
} from './provider.js';

interface ModelCaps {
  /** Adaptive thinking (always on for Opus 5.5; requested explicitly elsewhere). */
  adaptive: boolean;
  effort: boolean;
  /** Server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
}

const CAPS: Record<string, ModelCaps> = {
  'claude-opus-5-5': { adaptive: true, effort: true, fallbacks: true },
  'claude-sonnet-5-5': { adaptive: true, effort: true, fallbacks: true },
  'claude-haiku-4-5': { adaptive: false, effort: false, fallbacks: false },
};
const UNKNOWN_CAPS: ModelCaps = { adaptive: false, effort: false, fallbacks: false };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  const key = env().anthropicApiKey;
  if (!key) throw new ProviderError('not_configured', 'The AI provider is not configured on the server (ANTHROPIC_API_KEY).');
  if (!client) client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 10 * 60 * 1000 });
  return client;
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'Stopped.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('auth', 'The AI provider rejected the server credentials.');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError('model_unavailable', 'The configured model is not available to these AI provider credentials.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('rate_limited', 'The AI provider is rate limiting requests. Try again in a minute.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return new ProviderError('bad_request', `The AI provider rejected the request${detail ? `: ${detail.slice(0, 200)}` : '.'}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('unavailable', 'Could not reach the AI provider.');
  }
  if (err instanceof Anthropic.APIError) {
    return err.status === 529 || (err.status ?? 0) >= 500
      ? new ProviderError('overloaded', 'The AI provider is temporarily unavailable. Try again shortly.')
      : new ProviderError('bad_request', 'The AI provider returned an error.');
  }
  // Not an API error: the eagerly streamed tool input was not parseable JSON.
  return new ProviderError('invalid_tool_json', 'The model produced an unreadable tool call.');
}

function mapStop(reason: string | null): TurnStop {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'paused';
    case 'model_context_window_exceeded':
      return 'context_exceeded';
    default:
      return 'other';
  }
}

function usageOf(usage: BetaUsage): { usage: TurnUsage; fallbackUsed: boolean } {
  const iterations = usage.iterations ?? [];
  const fallbackUsed = iterations.some((i) => i.type === 'fallback_message');
  // usage.iterations is the per-attempt source of truth when present (a
  // declined attempt plus the fallback that served the response).
  const parts = iterations.filter((i) => 'input_tokens' in i && 'output_tokens' in i) as Array<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }>;
  if (parts.length > 0) {
    return {
      fallbackUsed,
      usage: parts.reduce<TurnUsage>(
        (acc, i) => ({
          input_tokens: acc.input_tokens + (i.input_tokens ?? 0),
          output_tokens: acc.output_tokens + (i.output_tokens ?? 0),
          cache_read_tokens: acc.cache_read_tokens + (i.cache_read_input_tokens ?? 0),
          cache_write_tokens: acc.cache_write_tokens + (i.cache_creation_input_tokens ?? 0),
        }),
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      ),
    };
  }
  return {
    fallbackUsed,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * After a mid-output fallback, blocks the declined model produced before the
 * last switch point must not be echoed back (except text and paired server
 * tool blocks).
 */
export function echoableContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') boundary = i;
  });
  if (boundary < 0) return content;
  const resultIds = new Set(
    content.filter((b) => b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  return content.filter((b, i) => {
    if (i >= boundary) return true;
    if (b.type === 'text') return true;
    if (b.type === 'server_tool_use') return resultIds.has(b.id);
    if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') return true;
    return false;
  });
}

class AnthropicSession implements ModelSession {
  private readonly messages: BetaMessageParam[] = [];
  private readonly tools: BetaToolUnion[];
  private readonly caps: ModelCaps;

  private readonly input: SessionInput;

  constructor(input: SessionInput) {
    this.input = input;
    this.caps = CAPS[input.model] ?? UNKNOWN_CAPS;
    for (const turn of input.history) this.messages.push({ role: turn.role, content: turn.text });
    this.messages.push({ role: 'user', content: input.userMessage });
    this.tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as { type: 'object'; properties?: unknown; required?: string[] },
      eager_input_streaming: true,
    }));
    if (input.webSearch) {
      this.tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: input.webSearch.maxUses });
    }
  }

  async next(cb: TurnCallbacks): Promise<TurnResult> {
    const anthropic = getClient();
    const useFallback = this.caps.fallbacks && env().refusalFallback;
    let message: BetaMessage;
    try {
      const stream = anthropic.beta.messages.stream(
        {
          model: this.input.model,
          max_tokens: this.input.maxTokens,
          system: this.input.system,
          messages: this.messages,
          ...(this.tools.length > 0 ? { tools: this.tools } : {}),
          cache_control: { type: 'ephemeral' },
          ...(this.caps.adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
          ...(this.caps.effort ? { output_config: { effort: this.input.effort } } : {}),
          ...(useFallback ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
        },
        { signal: cb.signal },
      );
      stream.on('text', (delta) => cb.onText(delta));
      stream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          const query = (block.input as { query?: unknown }).query;
          if (typeof query === 'string') cb.onWebSearch?.(query);
        }
      });
      message = await stream.finalMessage();
    } catch (err) {
      throw mapError(err);
    }

    const stop = mapStop(message.stop_reason);
    const content = echoableContent(message.content);
    // Append-only transcript: the assistant turn goes back unchanged (thinking
    // blocks included) so the next request continues it.
    if (stop === 'tool_use' || stop === 'paused') this.messages.push({ role: 'assistant', content });

    const webSources: WebSource[] = [];
    const webSearches: string[] = [];
    for (const block of message.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        const q = (block.input as { query?: unknown }).query;
        if (typeof q === 'string') webSearches.push(q);
      }
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) webSources.push({ url: r.url, title: r.title ?? null });
      }
    }
    const { usage, fallbackUsed } = usageOf(message.usage);
    return {
      text: message.content
        .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      toolCalls: content
        .filter((b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop,
      refusalCategory: stop === 'refusal' ? (message.stop_details?.category ?? null) : null,
      usage,
      model: message.model,
      fallbackUsed,
      webSearches,
      webSources,
    };
  }

  addToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): void {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError ?? false })),
    });
  }
}

export const anthropicProvider: ModelProvider = {
  name: 'anthropic',
  configured: () => Boolean(env().anthropicApiKey),
  startSession: (input) => new AnthropicSession(input),
};
