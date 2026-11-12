import { describe, expect, it } from 'vitest';
import { sessionOwnershipContext } from '../../server/agents/engine.js';

describe('conversation AI session ownership context', () => {
  const samuel = {
    id: 'd8fb3433-1899-48dc-827a-f2330d84d105',
    display_name: 'Samuel Buzatu',
    username: 'samuel.buzatu',
  };
  const berssey = {
    id: 'ee98a4e5-2359-4fc8-ac11-53d8e601f80d',
    display_name: 'Berssey',
    username: 'berssey',
  };

  it('makes two-person requests belong to the person being addressed, not the reviewer', () => {
    const context = sessionOwnershipContext([samuel, berssey], samuel.id, true);

    expect(context).toContain(`Samuel Buzatu (@samuel.buzatu) [user_id=${samuel.id}]: conversation participant; initiated this AI step`);
    expect(context).toContain(`Berssey (@berssey) [user_id=${berssey.id}]: conversation participant`);
    expect(context).toContain('This is a two-person conversation');
    expect(context).toContain('refer to the other human participant, not to the message author');
    expect(context).toContain('Never use the AI-run requester as a fallback owner');
  });

  it('keeps first-person commitments with their author and coordinators out of ownership', () => {
    const context = sessionOwnershipContext([samuel, berssey], samuel.id, true);

    expect(context).toContain('A first-person commitment');
    expect(context).toContain('belongs to that message author');
    expect(context).toContain('mentioned for coordination, consultation, or approval is not a task owner');
    expect(context).toContain('Preserve an unresolved owner as unassigned');
  });

  it('requires an explicit recipient in a group conversation', () => {
    const mary = {
      id: '0aef2269-a7f9-43e5-a231-a34093c2c6ae',
      display_name: 'Mary',
      username: null,
    };
    const context = sessionOwnershipContext([samuel, berssey, mary], samuel.id, false);

    expect(context).toContain('This is a group conversation');
    expect(context).toContain('Do not assign a second-person request unless its recipient is named');
    expect(context).toContain(`- Mary [user_id=${mary.id}]: conversation participant`);
  });

  it('does not infer a direct addressee in a two-member group channel', () => {
    const context = sessionOwnershipContext([samuel, berssey], samuel.id, false);

    expect(context).toContain('This is a group conversation');
    expect(context).toContain('unless its recipient is named');
    expect(context).not.toContain('refer to the other human participant');
  });
});
