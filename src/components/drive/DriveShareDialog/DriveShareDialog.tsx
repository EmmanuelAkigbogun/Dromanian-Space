import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { errorText, platform, result, workspacePeople } from '@/features/platform/client';
import s from '@/features/platform/Platform.module.css';
import styles from './DriveShareDialog.module.css';

interface DriveAccess {
  owner_id: string;
  my_role: string;
  can_manage: boolean;
  editors_can_share: boolean;
  audience_count: number;
  grants: Array<{
    id: string;
    label: string;
    role: string;
    inherited: boolean;
    via_name: string;
  }>;
}

interface ShareOption {
  id: string;
  name: string;
}

interface MemberOption {
  id: string;
  display_name: string | null;
  username: string | null;
}

interface DriveShareDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  userId: string;
  itemId: string;
  itemName: string;
  itemKind: string;
  onChanged?: () => void | Promise<unknown>;
}

export function DriveShareDialog({
  open,
  onClose,
  workspaceId,
  userId,
  itemId,
  itemName,
  itemKind,
  onChanged,
}: DriveShareDialogProps) {
  const cache = useQueryClient();
  const [target, setTarget] = useState('workspace');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget('workspace');
    setRole('viewer');
    setError('');
    setCopied(false);
  }, [itemId, open]);

  const access = useQuery({
    queryKey: ['platform', workspaceId, userId, 'drive-sharing', itemId],
    enabled: open,
    staleTime: 0,
    queryFn: async () => {
      const [accessResult, requests] = await Promise.all([
        result(platform.rpc('drive_get_access', { p_item_id: itemId })),
        result(platform.from('drive_access_requests').select('*').eq('item_id', itemId).eq('status', 'pending')),
      ]);
      return { access: accessResult as DriveAccess, requests };
    },
  });

  const options = useQuery({
    queryKey: ['platform', workspaceId, userId, 'drive-sharing-options'],
    enabled: open && access.data?.access.can_manage === true,
    staleTime: 30_000,
    queryFn: async () => {
      const [members, channelMemberships, projects] = await Promise.all([
        workspacePeople(workspaceId),
        result(platform.from('channel_members').select('channel_id').eq('user_id', userId)),
        result(platform.from('projects').select('id,name').eq('workspace_id', workspaceId).order('name')),
      ]);
      const channelIds = channelMemberships.map((membership: { channel_id: string }) => membership.channel_id);
      const channels = channelIds.length
        ? await result(platform.from('channels').select('id,name').eq('workspace_id', workspaceId).in('id', channelIds).order('name'))
        : [];
      return {
        members: members as MemberOption[],
        channels: channels as ShareOption[],
        projects: projects as ShareOption[],
      };
    },
  });

  async function refresh() {
    await cache.invalidateQueries({ queryKey: ['platform', workspaceId, userId, 'drive-sharing', itemId] });
    await onChanged?.();
  }

  async function act(operation: () => PromiseLike<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    const itemPath = itemKind === 'folder' ? `/drive/folder/${itemId}` : `/drive/item/${itemId}`;
    try {
      await navigator.clipboard.writeText(`${location.origin}${itemPath}`);
      setCopied(true);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const currentAccess = access.data?.access;
  const loadError = access.error ?? options.error;

  return (
    <Dialog open={open} onClose={onClose} title="Share" size="lg">
      <div className={styles.dialogContent}>
        <div className={styles.itemSummary}>
          <span className={styles.itemIcon} aria-hidden="true">{itemKind === 'folder' ? '▱' : '≡'}</span>
          <div>
            <strong>{itemName}</strong>
            <span>{currentAccess ? `${currentAccess.audience_count} ${currentAccess.audience_count === 1 ? 'person can' : 'people can'} open this ${itemKind === 'folder' ? 'folder' : 'file'}` : 'Checking access…'}</span>
          </div>
        </div>

        <div className={styles.linkRow}>
          <div>
            <strong>Restricted link</strong>
            <span>Only people granted access can open it. Copying the link never changes permissions.</span>
          </div>
          <button type="button" className={s.button} onClick={() => void copyLink()}>{copied ? 'Link copied' : 'Copy link'}</button>
        </div>

        {(error || loadError) && <p role="alert" className={s.error}>{error || errorText(loadError)}</p>}
        {access.isPending && <p className={s.muted} role="status">Loading sharing settings…</p>}

        {currentAccess?.my_role === 'owner' && (
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={currentAccess.editors_can_share}
              disabled={busy}
              onChange={(event) => void act(() => result(platform.rpc('drive_set_sharing_options', {
                p_item_id: itemId,
                p_restricted: null,
                p_editors_can_share: event.target.checked,
              })))}
            />
            <span><strong>Let editors share</strong><small>Editors can update access for this item and inherited contents.</small></span>
          </label>
        )}

        {currentAccess?.can_manage && (
          <form
            className={styles.grantForm}
            onSubmit={(event) => {
              event.preventDefault();
              const [principalType, principalId] = target.split(':');
              void act(() => result(platform.rpc('drive_share', {
                p_item_id: itemId,
                p_principal_type: principalType,
                p_principal_id: principalId ?? null,
                p_role: role,
              })));
            }}
          >
            <label>
              Share with
              <select className={s.input} value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy || options.isPending}>
                <option value="workspace">Everyone in this workspace</option>
                {options.data?.members
                  .filter((member) => member.id !== currentAccess.owner_id && member.id !== userId)
                  .map((member) => <option key={member.id} value={`user:${member.id}`}>{member.display_name || member.username || 'Workspace member'}</option>)}
                {options.data?.channels.map((channel) => <option key={channel.id} value={`channel:${channel.id}`}>Channel: {channel.name}</option>)}
                {options.data?.projects.map((project) => <option key={project.id} value={`project:${project.id}`}>Project: {project.name}</option>)}
              </select>
            </label>
            <label>
              Permission
              <select className={s.input} value={role} onChange={(event) => setRole(event.target.value)} disabled={busy}>
                <option value="viewer">Can view</option>
                <option value="commenter">Can comment</option>
                <option value="editor">Can edit</option>
              </select>
            </label>
            <button type="submit" className={s.primary} disabled={busy || options.isPending}>{busy ? 'Saving…' : 'Share'}</button>
          </form>
        )}

        {currentAccess && !currentAccess.can_manage && (
          <p className={styles.readOnlyNotice}>You have {currentAccess.my_role} access. Only the owner, or an editor allowed to share, can change who has access.</p>
        )}

        {!!currentAccess?.grants.length && (
          <section className={styles.accessList} aria-labelledby="drive-access-heading">
            <h3 id="drive-access-heading">People with access</h3>
            {currentAccess.grants.map((grant) => (
              <div className={styles.accessRow} key={grant.id}>
                <div>
                  <strong>{grant.label}</strong>
                  <span>{grant.role}{grant.inherited ? ` · inherited from ${grant.via_name}` : ''}</span>
                </div>
                {currentAccess.can_manage && !grant.inherited && (
                  <button type="button" className={s.button} disabled={busy} onClick={() => void act(() => result(platform.rpc('drive_unshare', { p_grant_id: grant.id })))}>Remove</button>
                )}
              </div>
            ))}
          </section>
        )}

        {currentAccess?.can_manage && !!access.data?.requests.length && (
          <section className={styles.accessList} aria-labelledby="drive-requests-heading">
            <h3 id="drive-requests-heading">Access requests</h3>
            {access.data.requests.map((request) => (
              <div className={styles.requestRow} key={request.id}>
                <div><strong>Requests {request.role} access</strong>{request.message && <span>{request.message}</span>}</div>
                <div>
                  <button type="button" className={s.button} disabled={busy} onClick={() => void act(() => result(platform.rpc('drive_decide_access_request', { p_request_id: request.id, p_approve: false })))}>Decline</button>
                  <button type="button" className={s.primary} disabled={busy} onClick={() => void act(() => result(platform.rpc('drive_decide_access_request', { p_request_id: request.id, p_approve: true })))}>Approve</button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </Dialog>
  );
}
