import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Effort, ModelProvider, ToolSpec, TurnUsage } from '../ai/provider.js';

export interface CrewAgentConfig {
  name: string;
  role: string;
  goal: string;
  description: string;
  instructions: string;
  kind: 'specialist' | 'coordinator';
  model: string;
  effort: string;
  tools: string[];
  max_iter: number;
  max_execution_time: number;
}

export interface CrewRunInput {
  run_id: string;
  agent: CrewAgentConfig;
  specialists: CrewAgentConfig[];
  prompt: string;
  tools: ToolSpec[];
  files?: Array<{ path: string; name: string; mime_type: string; size: number }>;
}

export interface CrewRunResult {
  text: string;
  usage: TurnUsage;
  model: string;
}

export interface CrewRunCallbacks {
  signal: AbortSignal;
  onDelta(text: string): void;
  onStage?(stage: string, label: string): void;
  onTeam?(agent: string, status: string): void;
  callTool(call: { id: string; name: string; input: unknown }): Promise<{ content: string; isError?: boolean }>;
}

export interface CrewRunner {
  run(input: CrewRunInput, callbacks: CrewRunCallbacks): Promise<CrewRunResult>;
}

/** Test/migration adapter; production always uses the CrewAI service. */
export function providerCrewRunner(provider: ModelProvider): CrewRunner {
  return {
    async run(input, callbacks) {
      const session = provider.startSession({
        model: input.agent.model,
        effort: input.agent.effort as Effort,
        system: input.agent.instructions,
        history: [],
        userMessage: input.prompt,
        tools: input.tools,
        webSearch: null,
        webFetch: null,
        maxTokens: 32_000,
      });
      let text = '';
      let usage: TurnUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
      let model = input.agent.model;
      callbacks.onStage?.('contacting_provider', 'Waiting for the AI provider');
      let receivedText = false;
      for (;;) {
        const turn = await session.next({
          signal: callbacks.signal,
          onText(text) {
            if (!receivedText) callbacks.onStage?.('generating', 'Writing the answer');
            receivedText = true;
            callbacks.onDelta(text);
          },
        });
        text += turn.text;
        usage = {
          input_tokens: usage.input_tokens + turn.usage.input_tokens,
          output_tokens: usage.output_tokens + turn.usage.output_tokens,
          cache_read_tokens: usage.cache_read_tokens + turn.usage.cache_read_tokens,
          cache_write_tokens: usage.cache_write_tokens + turn.usage.cache_write_tokens,
        };
        model = turn.model;
        if (turn.stop !== 'tool_use' || !turn.toolCalls.length) break;
        const results: Array<{ id: string; content: string; isError?: boolean }> = [];
        for (const call of turn.toolCalls) {
          const result = await callbacks.callTool(call);
          results.push({ id: call.id, content: result.content, isError: result.isError });
        }
        session.addToolResults(results);
      }
      return { text, usage, model };
    },
  };
}

interface ActiveRun {
  token: Buffer;
  callTool: CrewRunCallbacks['callTool'];
}

const active = new Map<string, ActiveRun>();
let bridge: Server | null = null;
let bridgeReady: Promise<void> | null = null;

function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  response.end(data);
}

async function body(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) throw new Error('request too large');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function ensureBridge(): Promise<void> {
  if (bridgeReady) return bridgeReady;
  const port = Number(process.env.CREW_TOOL_PORT ?? 3001);
  bridge = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true });
    if (request.method !== 'POST' || request.url !== '/tool') return json(response, 404, { error: 'not_found' });
    try {
      const value = await body(request);
      const runId = String(value.run_id ?? '');
      const entry = active.get(runId);
      const supplied = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), 'hex');
      if (!entry || supplied.length !== entry.token.length || !timingSafeEqual(supplied, entry.token)) {
        return json(response, 401, { error: 'unauthorized' });
      }
      const result = await entry.callTool({
        id: String(value.tool_use_id ?? ''),
        name: String(value.name ?? ''),
        input: value.input,
      });
      return json(response, 200, result);
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  bridgeReady = new Promise<void>((resolve, reject) => {
    bridge!.once('error', reject);
    bridge!.listen(port, '0.0.0.0', () => {
      bridge!.off('error', reject);
      bridge!.unref();
      resolve();
    });
  });
  return bridgeReady;
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error('CrewAI returned malformed streaming data.');
  }
}

export const remoteCrewRunner: CrewRunner = {
  async run(input, callbacks) {
    await ensureBridge();
    const token = randomBytes(32);
    active.set(input.run_id, { token, callTool: callbacks.callTool });
    const base = (process.env.CREWAI_URL ?? 'http://crew:8000').replace(/\/$/, '');
    const callbackHost = process.env.CREW_TOOL_CALLBACK_URL ?? `http://worker:${process.env.CREW_TOOL_PORT ?? 3001}/tool`;
    const authorization = `Bearer ${process.env.CREW_INTERNAL_TOKEN ?? process.env.APP_JWT_SECRET ?? ''}`;
    const cancel = () => {
      void fetch(`${base}/cancel/${encodeURIComponent(input.run_id)}`, {
        method: 'POST',
        headers: { authorization },
      }).catch(() => undefined);
    };
    callbacks.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(`${base}/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
          authorization,
        },
        body: JSON.stringify({ ...input, callback_url: callbackHost, callback_token: token.toString('hex') }),
        signal: callbacks.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`CrewAI runtime returned HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let result: CrewRunResult | null = null;
      const receive = (event: Record<string, unknown>) => {
        if (event.type === 'delta' && typeof event.text === 'string') callbacks.onDelta(event.text);
        if (event.type === 'stage' && typeof event.stage === 'string') {
          callbacks.onStage?.(event.stage, String(event.label ?? event.stage));
        }
        if (event.type === 'team' && typeof event.agent === 'string') callbacks.onTeam?.(event.agent, String(event.status ?? 'working'));
        if (event.type === 'error') throw new Error(String(event.message ?? 'CrewAI execution failed.'));
        if (event.type === 'result') {
          const u = (event.usage ?? {}) as Partial<TurnUsage>;
          result = {
            text: String(event.text ?? ''),
            model: String(event.model ?? input.agent.model),
            usage: {
              input_tokens: Number(u.input_tokens ?? 0),
              output_tokens: Number(u.output_tokens ?? 0),
              cache_read_tokens: Number(u.cache_read_tokens ?? 0),
              cache_write_tokens: Number(u.cache_write_tokens ?? 0),
            },
          };
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseLine(line);
          if (event) receive(event);
        }
        if (done) break;
      }
      if (pending.trim()) {
        const event = parseLine(pending);
        if (event) receive(event);
      }
      if (!result) throw new Error('CrewAI ended without a result.');
      return result;
    } finally {
      callbacks.signal.removeEventListener('abort', cancel);
      active.delete(input.run_id);
    }
  },
};
