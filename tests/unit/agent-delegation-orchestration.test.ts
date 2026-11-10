import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  rpc: vi.fn(),
  serviceClient: vi.fn(),
}));

vi.mock('../../server/database.js', () => database);

import { delegate } from '../../server/agents/engine.js';

describe('specialist delegation failure handling', () => {
  let resolveSecondStatus: (value: { data: { status: string }; error: null }) => void;
  let secondStatus: Promise<{ data: { status: string }; error: null }>;
  let terminalized: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    terminalized = [];
    secondStatus = new Promise((resolve) => {
      resolveSecondStatus = resolve;
    });

    database.rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === 'agent_delegate') {
        return [
          { task_id: 'task-1', child_run_id: 'child-1', agent_id: 'agent-1', reused: false },
          { task_id: 'task-2', child_run_id: 'child-2', agent_id: 'agent-2', reused: false },
        ];
      }
      if (name === 'agent_terminalize_team_task') {
        terminalized.push(params.p_task_id as string);
        return { status: 'cancelled' };
      }
      if (name === 'agent_settle_team_task') return { status: 'cancelled' };
      throw new Error(`Unexpected RPC ${name}`);
    });

    const fakeDb = {
      from(table: string) {
        if (table === 'workspace_agents') {
          const query = {
            select: () => query,
            eq: () => query,
            in: async () => ({
              data: [
                { id: 'agent-1', handle: 'one', name: 'One' },
                { id: 'agent-2', handle: 'two', name: 'Two' },
              ],
              error: null,
            }),
          };
          return query;
        }
        if (table === 'agent_runs') {
          let selection = '';
          let childId = '';
          const query = {
            select(value: string) {
              selection = value;
              return query;
            },
            eq(_column: string, value: string) {
              childId = value;
              return query;
            },
            single() {
              if (selection === 'status') {
                if (childId === 'child-1') {
                  return Promise.resolve({ data: null, error: { message: 'forced status lookup failure' } });
                }
                return secondStatus;
              }
              return Promise.resolve({
                data: {
                  status: 'cancelled',
                  output_message_id: `message-${childId}`,
                  error_message: 'Stopped after another lane failed.',
                },
                error: null,
              });
            },
          };
          return query;
        }
        if (table === 'agent_messages') {
          const query = {
            select: () => query,
            eq: () => query,
            single: async () => ({ data: { content: '' }, error: null }),
          };
          return query;
        }
        if (table === 'agent_citations') {
          const query = {
            select: () => query,
            eq: async () => ({ data: [], error: null }),
          };
          return query;
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };
    database.serviceClient.mockReturnValue(fakeDb);
  });

  it('waits for sibling lanes, aborts them, and terminalizes every persisted task when status lookup fails', async () => {
    const controller = new AbortController();
    let settled = false;
    const operation = delegate({
      runId: 'parent-run',
      workspaceId: 'workspace',
      worker: 'worker',
      ctx: { citations: {} } as never,
      tasks: [
        { agent: 'one', instruction: 'First task' },
        { agent: 'two', instruction: 'Second task' },
      ],
      deadline: Date.now() + 30_000,
      emit: () => undefined,
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    const rejection = expect(operation).rejects.toThrow(
      'Could not load specialist run child-1: forced status lookup failure',
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    resolveSecondStatus({ data: { status: 'queued' }, error: null });
    await rejection;

    expect(new Set(terminalized)).toEqual(new Set(['task-1', 'task-2']));
    expect(terminalized.filter((task) => task === 'task-1')).toHaveLength(1);
    expect(terminalized.filter((task) => task === 'task-2').length).toBeGreaterThanOrEqual(1);
  });
});
