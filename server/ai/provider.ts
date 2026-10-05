// Provider-neutral contract between the agent engine and a model provider.
// The provider owns its native transcript (including reasoning blocks that
// must be passed back unchanged); the engine only sees text, tool calls and
// results.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema with type "object". */
  inputSchema: Record<string, unknown>;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface WebSource {
  url: string;
  title: string | null;
}

export type TurnStop = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'paused' | 'context_exceeded' | 'other';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: TurnStop;
  refusalCategory: string | null;
  usage: TurnUsage;
  /** Model that produced the response (differs from the requested one after a fallback). */
  model: string;
  fallbackUsed: boolean;
  webSearches: string[];
  webSources: WebSource[];
}

export interface SessionInput {
  model: string;
  effort: Effort;
  system: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  userMessage: string;
  tools: ToolSpec[];
  webSearch: { maxUses: number } | null;
  /** Page fetches run by the provider, restricted to these domains (never by this server). */
  webFetch: { allowedDomains: string[]; maxUses: number } | null;
  maxTokens: number;
}

export interface TurnCallbacks {
  signal: AbortSignal;
  onText: (delta: string) => void;
  onWebSearch?: (query: string) => void;
  onWebFetch?: (url: string) => void;
}

export interface ModelSession {
  next(callbacks: TurnCallbacks): Promise<TurnResult>;
  addToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): void;
}

export interface ModelProvider {
  readonly name: string;
  configured(): boolean;
  startSession(input: SessionInput): ModelSession;
}

export type ProviderErrorCode =
  | 'not_configured'
  | 'auth'
  | 'model_unavailable'
  | 'rate_limited'
  | 'overloaded'
  | 'bad_request'
  | 'unavailable'
  | 'aborted'
  | 'invalid_tool_json';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function emptyUsage(): TurnUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
  };
}
