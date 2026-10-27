import { z } from 'zod';
import { rpc } from '../../database.js';
import { proposeAction } from './propose.js';
import { defineTool, quoteData } from './types.js';

interface DriveRow {
  id: string;
  kind: string;
  name: string;
  mime_type: string | null;
  parent_id: string | null;
  my_role: string;
  owner_id: string;
  updated_at: string;
}

export const listDrive = defineTool({
  name: 'list_drive',
  description: 'List or search Drive items the requester can open. Results include IDs for read_file and reviewed Drive actions.',
  schema: z.object({
    query: z.string().max(200).optional(),
    folder_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  label: (input) => (input.query ? `Searching Drive for “${input.query}”` : 'Listing Drive files'),
  async run(ctx, input) {
    const rows = await rpc<DriveRow[]>('agent_list_drive_for', {
      p_actor: ctx.actorId,
      p_workspace_id: ctx.workspaceId,
      p_query: input.query ?? null,
      p_folder_id: input.folder_id ?? null,
      p_limit: input.limit ?? 20,
    });
    const visibleRows = ctx.allowedItemIds ? rows.filter((row) => ctx.allowedItemIds!.includes(row.id)) : rows;
    for (const row of visibleRows) await ctx.recordSource('drive_item', row.id, { itemId: row.id, label: row.name });
    return {
      content: visibleRows.length
        ? visibleRows.map((row) => quoteData('drive_item', {
            item_id: row.id, kind: row.kind, role: row.my_role, parent_id: row.parent_id,
            link: `/drive/item/${row.id}`, updated_at: row.updated_at,
          }, `${row.name}${row.mime_type ? ` (${row.mime_type})` : ''}`)).join('\n')
        : 'No accessible Drive items matched.',
      summary: { results: visibleRows.length },
    };
  },
});

export const proposeDriveAction = defineTool({
  name: 'propose_drive_action',
  description: 'Propose creating a folder, renaming one of the requester\'s Drive items, or moving one of their items. Nothing changes until the requester approves.',
  schema: z.object({
    operation: z.enum(['create_folder', 'rename', 'move']),
    item_id: z.string().uuid().optional(),
    name: z.string().min(1).max(255).optional(),
    folder_id: z.string().uuid().nullable().optional().describe('Destination/parent folder; null means My files'),
  }),
  label: (input) => ({ create_folder: 'Preparing a Drive folder for review', rename: 'Preparing a Drive rename for review', move: 'Preparing a Drive move for review' })[input.operation],
  async run(ctx, input, call) {
    const inScope = (id: string | null | undefined) => !id || !ctx.allowedItemIds || ctx.allowedItemIds.includes(id);
    if (input.operation === 'create_folder') {
      if (!input.name) return { content: 'A folder name is required.', summary: { error: 'missing_name' }, isError: true };
      if (!inScope(input.folder_id)) return { content: 'That folder is outside this agent\'s selected sources.', summary: { error: 'out_of_scope' }, isError: true };
      const summary = `Create Drive folder “${input.name}”`;
      return proposeAction(ctx, call.toolUseId, 'create_drive_folder', { name: input.name, folder_id: input.folder_id ?? null }, summary);
    }
    if (!input.item_id) return { content: 'An item_id is required.', summary: { error: 'missing_item' }, isError: true };
    if (!inScope(input.item_id) || !inScope(input.folder_id)) {
      return { content: 'That Drive item is outside this agent\'s selected sources.', summary: { error: 'out_of_scope' }, isError: true };
    }
    if (input.operation === 'rename') {
      if (!input.name) return { content: 'A new name is required.', summary: { error: 'missing_name' }, isError: true };
      return proposeAction(ctx, call.toolUseId, 'rename_drive_item', { item_id: input.item_id, name: input.name }, `Rename Drive item to “${input.name}”`);
    }
    return proposeAction(ctx, call.toolUseId, 'move_drive_item', { item_id: input.item_id, folder_id: input.folder_id ?? null }, 'Move Drive item');
  },
});
