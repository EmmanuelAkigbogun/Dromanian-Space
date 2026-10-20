import { ApiError, GoogleGenAI } from '@google/genai';
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

type InteractionUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
};

type TextAnnotation = { type?: string; url?: string; title?: string };

type InteractionStep =
  | { type: 'user_input'; content: Array<{ type: 'text'; text: string }> }
  | { type: 'model_output'; content: Array<{ type: 'text'; text: string }> }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'function_result'; call_id: string; name?: string; result: string; is_error?: boolean };

type PendingCall = {
  id: string;
  name: string;
  initialArguments: Record<string, unknown>;
  argumentDelta: string;
};

type InteractionTool =
  | { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }
  | { type: 'google_search' };

let client: GoogleGenAI | null = null;
let clientKey: string | null = null;
let clientInjectedForTests = false;

const RESILIENT_FLASH_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;
const GEMINI_FIRST_OUTPUT_TIMEOUT_MS = 45_000;

/**
 * Gemini capacity and free-tier quotas are model-specific. Keep every retry on
 * Google, but move down the Flash line when the requested model is overloaded
 * or temporarily rate limited. The next conversation starts at the requested
 * model again, so a transient fallback never changes an agent's configuration.
 */
export function geminiModelCandidates(requested: string): string[] {
  const start = RESILIENT_FLASH_MODELS.indexOf(requested as (typeof RESILIENT_FLASH_MODELS)[number]);
  if (start >= 0) return [...RESILIENT_FLASH_MODELS.slice(start)];
  return [requested, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter((model, index, all) => all.indexOf(model) === index);
}

/** For adapter tests; production always constructs the SDK client from the server-side key. */
export function setGeminiClientForTests(value: GoogleGenAI | null): void {
  client = value;
  clientInjectedForTests = value !== null;
  clientKey = null;
}

function getClient(): GoogleGenAI {
  if (clientInjectedForTests && client) return client;
  const key = env().geminiApiKey;
  if (!key) throw new ProviderError('not_configured', 'Google Gemini is not configured on the server (GEMINI_API or GEMINI_API_KEY).');
  if (!client || clientKey !== key) {
    client = new GoogleGenAI({ apiKey: key });
    clientKey = key;
  }
  return client;
}

function canTryAnotherModel(error: ProviderError): boolean {
  return error.code === 'overloaded'
    || error.code === 'rate_limited'
    || error.code === 'unavailable'
    || error.code === 'model_unavailable';
}

function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
    return new ProviderError('aborted', 'Stopped.');
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return new ProviderError('auth', 'Google rejected the Gemini API credentials.');
    if (error.status === 404) return new ProviderError('model_unavailable', 'The selected Gemini model is not available to this API key.');
    if (error.status === 429) return new ProviderError('rate_limited', 'Google Gemini is rate limiting requests or the project quota is exhausted.');
    if (error.status >= 500) return new ProviderError('overloaded', 'Google Gemini is temporarily unavailable. Try again shortly.');
    return new ProviderError('bad_request', `Google Gemini rejected the request${error.message ? `: ${error.message.slice(0, 200)}` : '.'}`);
  }
  return new ProviderError('unavailable', 'The Google Gemini response failed before it completed.');
}

function mapStop(status: string | undefined, hasTools: boolean): TurnStop {
  if (hasTools || status === 'requires_action') return 'tool_use';
  if (!status || status === 'completed') return 'end';
  if (status === 'incomplete' || status === 'budget_exceeded') return 'max_tokens';
  return 'other';
}

function usageOf(value: InteractionUsage | undefined): TurnUsage {
  const cacheRead = value?.total_cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (value?.total_input_tokens ?? 0) - cacheRead),
    output_tokens: value?.total_output_tokens ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
  };
}

function thinkingLevel(effort: SessionInput['effort']): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

function parseArguments(call: PendingCall): Record<string, unknown> {
  if (!call.argumentDelta) return call.initialArguments;
  try {
    const parsed: unknown = JSON.parse(call.argumentDelta);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError('invalid_tool_json', `Gemini produced unreadable input for the ${call.name} tool.`);
  }
  throw new ProviderError('invalid_tool_json', `Gemini produced invalid input for the ${call.name} tool.`);
}

class GeminiSession implements ModelSession {
  private readonly transcript: InteractionStep[] = [];
  private readonly tools: InteractionTool[] = [];
  private readonly input: SessionInput;
  private readonly pendingCallNames = new Map<string, string>();
  private activeModel: string;
  private turn = 0;

  constructor(input: SessionInput) {
    this.input = input;
    this.activeModel = input.model;
    for (const turn of input.history) {
      this.transcript.push({
        type: turn.role === 'assistant' ? 'model_output' : 'user_input',
        content: [{ type: 'text', text: turn.text }],
      });
    }
    this.transcript.push({ type: 'user_input', content: [{ type: 'text', text: input.userMessage }] });
    for (const tool of input.tools) {
      this.tools.push({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema });
    }
    if (input.webSearch || input.webFetch) this.tools.push({ type: 'google_search' });
  }

  async next(callbacks: TurnCallbacks): Promise<TurnResult> {
    this.turn += 1;
    let text = '';
    let status: string | undefined;
    let usage: InteractionUsage | undefined;
    let model = this.activeModel;
    let pendingCalls = new Map<number, PendingCall>();
    let webSearches: string[] = [];
    let webSources: WebSource[] = [];

    const candidates = geminiModelCandidates(this.activeModel);
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const requestedModel = candidates[attempt];
      text = '';
      status = undefined;
      usage = undefined;
      model = requestedModel;
      pendingCalls = new Map<number, PendingCall>();
      webSearches = [];
      webSources = [];
      const seenSources = new Set<string>();
      let madeVisibleProgress = false;
      let firstOutputTimedOut = false;
      const attemptController = new AbortController();
      const abortAttempt = (): void => attemptController.abort(callbacks.signal.reason);
      if (callbacks.signal.aborted) abortAttempt();
      else callbacks.signal.addEventListener('abort', abortAttempt, { once: true });
      const firstOutputTimeout = setTimeout(() => {
        firstOutputTimedOut = true;
        attemptController.abort(new Error('Gemini did not start responding in time.'));
      }, GEMINI_FIRST_OUTPUT_TIMEOUT_MS);
      const markVisibleProgress = (): void => {
        if (madeVisibleProgress) return;
        madeVisibleProgress = true;
        clearTimeout(firstOutputTimeout);
      };
      const addSources = (annotations: TextAnnotation[] | undefined): void => {
        for (const annotation of annotations ?? []) {
          if (annotation.type !== 'url_citation' || !annotation.url || seenSources.has(annotation.url)) continue;
          seenSources.add(annotation.url);
          webSources.push({ url: annotation.url, title: annotation.title ?? null });
        }
      };

      try {
        const stream = await getClient().interactions.create(
          {
            model: requestedModel,
            input: this.transcript,
            system_instruction: this.input.system,
            generation_config: {
              max_output_tokens: this.input.maxTokens,
              thinking_level: thinkingLevel(this.input.effort),
            },
            ...(this.tools.length > 0 ? { tools: this.tools } : {}),
            stream: true,
            store: false,
          },
          { signal: attemptController.signal, timeout_ms: 10 * 60 * 1000 },
        );

        for await (const event of stream) {
          if (event.event_type === 'interaction.created') {
            model = event.interaction.model ?? model;
            status = event.interaction.status;
            continue;
          }
          if (event.event_type === 'interaction.status_update') {
            status = event.status;
            usage = event.usage ?? usage;
            continue;
          }
          if (event.event_type === 'step.start') {
            if (event.step.type === 'function_call') {
              markVisibleProgress();
              pendingCalls.set(event.index, {
                id: event.step.id || `gemini-${this.turn}-${event.index + 1}`,
                name: event.step.name,
                initialArguments: event.step.arguments ?? {},
                argumentDelta: '',
              });
            }
            if (event.step.type === 'google_search_call') {
              markVisibleProgress();
              for (const query of event.step.arguments.queries ?? []) {
                if (webSearches.includes(query)) continue;
                webSearches.push(query);
                callbacks.onWebSearch?.(query);
              }
            }
            if (event.step.type === 'model_output') {
              for (const content of event.step.content ?? []) {
                if (content.type === 'text') addSources(content.annotations);
              }
            }
            continue;
          }
          if (event.event_type === 'step.delta') {
            if (event.delta.type === 'text') {
              markVisibleProgress();
              text += event.delta.text;
              callbacks.onText(event.delta.text);
            } else if (event.delta.type === 'arguments_delta') {
              const call = pendingCalls.get(event.index);
              if (call) call.argumentDelta += event.delta.arguments ?? '';
            } else if (event.delta.type === 'google_search_call') {
              markVisibleProgress();
              for (const query of event.delta.arguments.queries ?? []) {
                if (webSearches.includes(query)) continue;
                webSearches.push(query);
                callbacks.onWebSearch?.(query);
              }
            } else if (event.delta.type === 'text_annotation_delta') {
              addSources(event.delta.annotations);
            }
            usage = event.metadata?.total_usage ?? usage;
            continue;
          }
          if (event.event_type === 'step.stop') {
            usage = event.usage ?? event.step_usage ?? usage;
            continue;
          }
          if (event.event_type === 'interaction.completed') {
            status = event.interaction.status;
            model = event.interaction.model ?? model;
            usage = event.interaction.usage ?? usage;
            continue;
          }
          if (event.event_type === 'error') {
            throw new ProviderError('unavailable', event.error?.message?.slice(0, 200) || 'Google Gemini returned a streaming error.');
          }
        }
        this.activeModel = requestedModel;
        break;
      } catch (error) {
        const mapped = firstOutputTimedOut && !callbacks.signal.aborted
          ? new ProviderError('unavailable', 'Google Gemini did not start responding in time.')
          : mapError(error);
        const hasAnother = attempt + 1 < candidates.length;
        if (madeVisibleProgress || !hasAnother || !canTryAnotherModel(mapped)) throw mapped;
      } finally {
        clearTimeout(firstOutputTimeout);
        callbacks.signal.removeEventListener('abort', abortAttempt);
      }
    }

    const toolCalls = [...pendingCalls.values()].map((call) => ({ id: call.id, name: call.name, input: parseArguments(call) }));
    if (text) this.transcript.push({ type: 'model_output', content: [{ type: 'text', text }] });
    for (const call of toolCalls) {
      this.pendingCallNames.set(call.id, call.name);
      this.transcript.push({ type: 'function_call', id: call.id, name: call.name, arguments: call.input as Record<string, unknown> });
    }

    return {
      text,
      toolCalls,
      stop: mapStop(status, toolCalls.length > 0),
      refusalCategory: null,
      usage: usageOf(usage),
      model,
      fallbackUsed: this.activeModel !== this.input.model,
      webSearches,
      webSources,
    };
  }

  addToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): void {
    for (const result of results) {
      this.transcript.push({
        type: 'function_result',
        call_id: result.id,
        name: this.pendingCallNames.get(result.id),
        result: result.content,
        is_error: result.isError ?? false,
      });
    }
  }
}

export const geminiProvider: ModelProvider = {
  name: 'gemini',
  configured: () => Boolean(env().geminiApiKey),
  startSession: (input) => new GeminiSession(input),
};
