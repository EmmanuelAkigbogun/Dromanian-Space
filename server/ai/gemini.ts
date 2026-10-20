import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Tool,
} from '@google/genai';
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

let client: GoogleGenAI | null = null;
let clientKey: string | null = null;

function getClient(): GoogleGenAI {
  const key = env().geminiApiKey;
  if (!key) throw new ProviderError('not_configured', 'Google Gemini is not configured on the server (GEMINI_API_KEY).');
  if (!client || clientKey !== key) {
    client = new GoogleGenAI({ apiKey: key });
    clientKey = key;
  }
  return client;
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

function mapStop(reason: FinishReason | undefined, hasTools: boolean): TurnStop {
  if (hasTools) return 'tool_use';
  if (!reason || reason === FinishReason.STOP) return 'end';
  if (reason === FinishReason.MAX_TOKENS) return 'max_tokens';
  if ([FinishReason.SAFETY, FinishReason.BLOCKLIST, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII, FinishReason.IMAGE_SAFETY].includes(reason)) return 'refusal';
  if (reason === FinishReason.MALFORMED_FUNCTION_CALL || reason === FinishReason.UNEXPECTED_TOOL_CALL) return 'other';
  return 'other';
}

function usageOf(value: GenerateContentResponseUsageMetadata | undefined): TurnUsage {
  const cacheRead = value?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: Math.max(0, (value?.promptTokenCount ?? 0) - cacheRead),
    output_tokens: value?.candidatesTokenCount ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
  };
}

class GeminiSession implements ModelSession {
  private readonly contents: Content[] = [];
  private readonly tools: Tool[] = [];
  private readonly input: SessionInput;
  private readonly pendingCallNames = new Map<string, string>();
  private turn = 0;

  constructor(input: SessionInput) {
    this.input = input;
    for (const turn of input.history) {
      this.contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.text }] });
    }
    this.contents.push({ role: 'user', parts: [{ text: input.userMessage }] });
    if (input.tools.length > 0) {
      this.tools.push({
        functionDeclarations: input.tools.map((tool): FunctionDeclaration => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema,
        })),
      });
    }
    if (input.webSearch || input.webFetch) this.tools.push({ googleSearch: {} });
  }

  async next(callbacks: TurnCallbacks): Promise<TurnResult> {
    this.turn += 1;
    let text = '';
    let finishReason: FinishReason | undefined;
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let model = this.input.model;
    const toolCalls: TurnResult['toolCalls'] = [];
    const modelParts: Part[] = [];
    const webSearches: string[] = [];
    const webSources: WebSource[] = [];
    const seenCalls = new Set<string>();
    const seenSources = new Set<string>();

    try {
      const stream = await getClient().models.generateContentStream({
        model: this.input.model,
        contents: this.contents,
        config: {
          systemInstruction: this.input.system,
          maxOutputTokens: this.input.maxTokens,
          abortSignal: callbacks.signal,
          ...(this.tools.length > 0 ? { tools: this.tools } : {}),
        },
      });
      for await (const chunk of stream) {
        const delta = chunk.text ?? '';
        if (delta) {
          text += delta;
          callbacks.onText(delta);
        }
        model = chunk.modelVersion ?? model;
        usage = chunk.usageMetadata ?? usage;
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        for (const call of chunk.functionCalls ?? []) {
          const signature = `${call.id ?? ''}:${call.name ?? ''}:${JSON.stringify(call.args ?? {})}`;
          if (seenCalls.has(signature) || !call.name) continue;
          seenCalls.add(signature);
          const id = call.id ?? `gemini-${this.turn}-${toolCalls.length + 1}`;
          this.pendingCallNames.set(id, call.name);
          const storedCall = { ...call, id };
          modelParts.push({ functionCall: storedCall });
          toolCalls.push({ id, name: call.name, input: call.args ?? {} });
        }
        const grounding = candidate?.groundingMetadata;
        for (const query of grounding?.webSearchQueries ?? []) {
          if (!webSearches.includes(query)) {
            webSearches.push(query);
            callbacks.onWebSearch?.(query);
          }
        }
        for (const source of grounding?.groundingChunks ?? []) {
          const url = source.web?.uri;
          if (!url || seenSources.has(url)) continue;
          seenSources.add(url);
          webSources.push({ url, title: source.web?.title ?? null });
        }
      }
    } catch (error) {
      throw mapError(error);
    }

    if (text) modelParts.unshift({ text });
    if (modelParts.length > 0) this.contents.push({ role: 'model', parts: modelParts });
    const stop = mapStop(finishReason, toolCalls.length > 0);
    return {
      text,
      toolCalls,
      stop,
      refusalCategory: stop === 'refusal' ? finishReason ?? null : null,
      usage: usageOf(usage),
      model,
      fallbackUsed: false,
      webSearches,
      webSources,
    };
  }

  addToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): void {
    this.contents.push({
      role: 'user',
      parts: results.map((result) => ({
        functionResponse: {
          id: result.id,
          name: this.pendingCallNames.get(result.id),
          response: result.isError ? { error: result.content } : { output: result.content },
        },
      })),
    });
  }
}

export const geminiProvider: ModelProvider = {
  name: 'gemini',
  configured: () => Boolean(env().geminiApiKey),
  startSession: (input) => new GeminiSession(input),
};
