import { describe, expect, it } from 'vitest';
import { providerAgentRunner, type AgentRunInput } from '../../server/agents/agno.js';
import { emptyUsage, type ModelProvider, type TurnResult } from '../../server/ai/provider.js';

const input: AgentRunInput = {
  run_id: '00000000-0000-4000-8000-000000000001',
  prompt: 'Read the policy.',
  agent: {
    name: 'Haven', role: 'Support', goal: 'Answer accurately', description: 'Support specialist', instructions: 'Use workspace sources.',
    kind: 'specialist', model: 'test-model', effort: 'medium', tools: ['read_file'], max_iter: 4, max_execution_time: 60,
  },
  specialists: [],
  tools: [{
    name: 'read_file', description: 'Read a file',
    inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] },
  }],
};

function result(overrides: Partial<TurnResult>): TurnResult {
  return {
    text: '', toolCalls: [], stop: 'end', refusalCategory: null, usage: emptyUsage(), model: 'test-model', fallbackUsed: false,
    webSearches: [], webSources: [], ...overrides,
  };
}

describe('Agno runner contract', () => {
  it('bridges Agno tool requests through the workspace tool callback', async () => {
    let step = 0;
    const toolResults: string[] = [];
    const provider: ModelProvider = {
      name: 'test', configured: () => true,
      startSession: () => ({
        async next(options) {
          step++;
          if (step === 1) return result({ stop: 'tool_use', toolCalls: [{ id: 'call-1', name: 'read_file', input: { item_id: 'doc-1' } }] });
          options.onText('The policy is available.');
          return result({ text: 'The policy is available.', usage: { ...emptyUsage(), output_tokens: 7 } });
        },
        addToolResults(values) { toolResults.push(...values.map((value) => value.content)); },
      }),
    };
    const calls: string[] = [];
    const stages: string[] = [];
    const output = await providerAgentRunner(provider).run(input, {
      signal: new AbortController().signal,
      onDelta: () => undefined,
      onStage(stage) { stages.push(stage); },
      async callTool(call) {
        calls.push(call.name);
        return { content: 'Policy: approved.' };
      },
    });
    expect(calls).toEqual(['read_file']);
    expect(toolResults).toEqual(['Policy: approved.']);
    expect(stages).toEqual(['contacting_provider', 'generating']);
    expect(output).toMatchObject({ text: 'The policy is available.', model: 'test-model', usage: { output_tokens: 7 } });
  });
});
