import { describe, expect, it } from 'vitest';
import { providerCrewRunner, type CrewRunInput } from '../../server/agents/crew.js';
import { emptyUsage, type ModelProvider, type TurnResult } from '../../server/ai/provider.js';

const input: CrewRunInput = {
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

describe('CrewAI runner contract', () => {
  it('bridges CrewAI tool requests through the workspace tool callback', async () => {
    let step = 0;
    const toolResults: string[] = [];
    const provider: ModelProvider = {
      name: 'test', configured: () => true,
      startSession: () => ({
        async next() {
          step++;
          return step === 1
            ? result({ stop: 'tool_use', toolCalls: [{ id: 'call-1', name: 'read_file', input: { item_id: 'doc-1' } }] })
            : result({ text: 'The policy is available.', usage: { ...emptyUsage(), output_tokens: 7 } });
        },
        addToolResults(values) { toolResults.push(...values.map((value) => value.content)); },
      }),
    };
    const calls: string[] = [];
    const output = await providerCrewRunner(provider).run(input, {
      signal: new AbortController().signal,
      onDelta: () => undefined,
      async callTool(call) {
        calls.push(call.name);
        return { content: 'Policy: approved.' };
      },
    });
    expect(calls).toEqual(['read_file']);
    expect(toolResults).toEqual(['Policy: approved.']);
    expect(output).toMatchObject({ text: 'The policy is available.', model: 'test-model', usage: { output_tokens: 7 } });
  });
});
