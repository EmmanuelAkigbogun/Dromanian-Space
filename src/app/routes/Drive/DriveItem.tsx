// A file's page, laid out like Google Drive's viewer: a top bar with the
// name and actions, the preview on a stage, and a side panel with Details,
// Activity (versions) and Comments.
import { parseCsv } from '../../../../shared/csv';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { platform, result, api, errorText, workspacePeople, type Row } from '@/features/platform/client';
import s from '@/features/platform/Platform.module.css';
import { OfficeEditor, isOfficeFile } from '@/components/drive/OfficeEditor';
import { DriveShareDialog } from '@/components/drive/DriveShareDialog';
import { useFeatureAccess } from '@/lib/workspace/features';
import { formatSize, kindLabel, type Item } from './driveModel';
import { ItemMenu, MoveDialog, RenameDialog, TypeIcon, type MenuAction } from './driveUi';
import styles from './DriveItem.module.css';

interface Access { my_role: string; can_manage: boolean; editors_can_share: boolean; audience_count: number; grants: Array<{ id: string; label: string; role: string; inherited: boolean; via_name: string; principal_type: string }> }
type Panel = 'details' | 'activity' | 'comments';

const readPanel = (): Panel | null => {
  // On small screens the panel is a sheet over the file, so it starts closed.
  if (typeof window !== 'undefined' && window.innerWidth < 1000) return null;
  try {
    const v = localStorage.getItem('drive.panel');
    return v === 'none' ? null : v === 'activity' || v === 'comments' ? v : 'details';
  } catch { return 'details'; }
};

export function DriveItem({ itemId, workspaceId: ws, userId }: { itemId: string; workspaceId: string; userId: string }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(params.get('panel') === 'sharing');
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [panel, setPanelState] = useState<Panel | null>(() => (params.get('panel') === 'comments' ? 'comments' : readPanel()));
  const setPanel = (p: Panel | null) => { setPanelState(p); try { localStorage.setItem('drive.panel', p ?? 'none'); } catch { /* per-viewer only */ } };
  const [comment, setComment] = useState('');
  const [requested, setRequested] = useState(false);
  const [editing, setEditing] = useState(params.get('edit') === '1');
  const aiVisible = useFeatureAccess().canSee('ai');
  const office = useQuery({ queryKey: ['platform', 'office-status'], staleTime: 300000, retry: false, queryFn: async () => (await (await api('office/status')).json()) as { enabled: boolean } });
  const base = ['platform', ws, userId, 'item', itemId];
  const item = useQuery({ queryKey: base, queryFn: () => result(platform.from('drive_items').select('*').eq('workspace_id', ws).eq('id', itemId).maybeSingle()), staleTime: 0, refetchInterval: 15000 });
  const detail = useQuery({
    queryKey: [...base, 'details', params.get('revision')], enabled: !!item.data && !item.data.trashed_at, refetchInterval: 15000,
    queryFn: async () => {
      const [access, revisions, versions, comments, sources, star, crumbs] = await Promise.all([
        result(platform.rpc('drive_get_access', { p_item_id: itemId })),
        result(params.get('revision')
          ? platform.from('drive_document_revisions').select('*').eq('item_id', itemId).eq('id', params.get('revision')!)
          : platform.from('drive_document_revisions').select('*').eq('item_id', itemId).order('revision_no', { ascending: false }).limit(25)),
        result(platform.from('drive_versions').select('*').eq('item_id', itemId).eq('status', 'ready').order('version_no', { ascending: false }).limit(25)),
        result(platform.from('drive_comments').select('*').eq('item_id', itemId).is('deleted_at', null).order('created_at').limit(100)),
        result(platform.from('knowledge_sources').select('*').eq('item_id', itemId).is('superseded_at', null)),
        result(platform.from('drive_item_stars').select('item_id').eq('item_id', itemId).eq('user_id', userId).maybeSingle()),
        result(platform.rpc('drive_breadcrumbs', { p_item_id: itemId })),
      ]);
      return { access: access as unknown as Access, revisions, versions, comments, sources, starred: !!star, crumbs: crumbs.slice(0, -1) };
    },
  });
  const people = useQuery({ queryKey: ['platform', ws, 'people'], staleTime: 300000, queryFn: () => workspacePeople(ws) });
  const nameOf = (id: string | null | undefined) => (id === userId ? 'You' : people.data?.find((p) => p.id === id)?.display_name ?? 'Workspace member');
  const refresh = () => cache.invalidateQueries({ queryKey: ['platform', ws, userId] });
  async function act(fn: () => PromiseLike<unknown>) { setBusy(true); setError(''); try { await fn(); await refresh(); return true; } catch (e) { setError(errorText(e)); return false; } finally { setBusy(false); } }
  useEffect(() => { void platform.rpc('drive_record_view', { p_item_id: itemId }); }, [itemId]);

  if (item.isPending) return <div className={styles.viewer} data-content-layout="full-bleed"><div className={styles.stageMessage}>Loading file…</div></div>;
  if (!item.data || item.data.trashed_at) {
    return (
      <div className={s.page}>
        <Link to="/drive">← Drive</Link>
        <div className={s.empty}>
          <h1>File unavailable</h1>
          <p>This link may require access, or the file may have been removed.</p>
          {item.error && <p>{errorText(item.error)}</p>}
          <button className={s.button} disabled={requested || busy} onClick={() => void act(async () => { await result(platform.rpc('drive_request_access', { p_item_id: itemId })); setRequested(true); })}>
            {requested ? 'Access request submitted' : 'Request access'}
          </button>
        </div>
      </div>
    );
  }

  const d = item.data;
  const asItem = { ...d, my_role: detail.data?.access?.my_role ?? 'viewer', starred: detail.data?.starred ?? false, owner_name: nameOf(d.owner_id), total_count: 1 } as unknown as Item;
  const access = detail.data?.access;
  const editable = access?.my_role === 'owner' || access?.my_role === 'editor';
  const canComment = ['owner', 'editor', 'commenter'].includes(access?.my_role ?? '');
  const pdfFile = d.kind === 'file' && (/\.pdf$/i.test(d.name) || d.mime_type === 'application/pdf');
  const officeFile = d.kind === 'file' && isOfficeFile(d.name) && !!office.data?.enabled;
  const zipFile = d.kind === 'file' && (/\.zip$/i.test(d.name) || d.mime_type === 'application/zip');
  const backTo = d.parent_id ? `/drive/folder/${d.parent_id}` : '/drive?view=my';
  const starred = detail.data?.starred ?? false;
  const viewingOld = params.get('version') || params.get('revision');

  if (editing && officeFile) {
    return <div className={styles.officeMode} data-content-layout="full-bleed"><OfficeEditor itemId={itemId} title={d.name} onClose={() => { void refresh(); if (params.get('edit') === '1') navigate(backTo); else setEditing(false); }} /></div>;
  }

  const download = async () => {
    const v = detail.data?.versions.find((x) => x.id === (params.get('version') ?? d.current_version_id));
    if (!v) { setError('There is no file to download yet.'); return; }
    const signed = await result(platform.storage.from(v.storage_bucket).createSignedUrl(v.storage_path, 60));
    const a = document.createElement('a');
    a.href = signed.signedUrl;
    a.download = d.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const moreActions: MenuAction[] = [
    ...(officeFile ? [{ label: pdfFile ? (editable ? 'Fill PDF form' : 'Open PDF') : editable ? 'Open in editor' : 'Open in viewer', icon: '✎', onSelect: () => setEditing(true) }] : []),
    ...(d.kind === 'file' ? [{ label: 'Download', icon: '⤓', onSelect: () => { download().catch((e) => setError(errorText(e))); } }] : []),
    { label: 'Rename', icon: '✎', disabled: !editable, hint: editable ? undefined : 'You need edit access', onSelect: () => setRenaming(true) },
    { label: 'Share', icon: '⇪', divider: true, onSelect: () => setSharing(true) },
    { label: 'Move to…', icon: '→', disabled: !editable, onSelect: () => setMoving(true) },
    { label: starred ? 'Remove from Starred' : 'Add to Starred', icon: '★', onSelect: () => void act(() => result(platform.rpc('drive_toggle_star', { p_item_id: itemId }))) },
    ...(zipFile ? [{ label: 'Extract here', icon: '⇲', onSelect: () => void act(async () => { const r = await (await api('drive/unzip', { item_id: itemId })).json() as { folder_id: string }; navigate(`/drive/folder/${r.folder_id}`); }) }] : []),
    ...(aiVisible ? [{ label: 'Ask an agent', icon: '✦', onSelect: () => navigate(`/agents?source=${itemId}`) }] : []),
    { label: 'Details', icon: 'ⓘ', onSelect: () => setPanel('details') },
    { label: 'Activity and versions', icon: '↺', onSelect: () => setPanel('activity') },
    { label: 'Comments', icon: '💬', onSelect: () => setPanel('comments') },
    { label: 'Move to Trash', icon: '🗑', danger: true, divider: true, disabled: !editable, onSelect: () => void act(async () => { await result(platform.rpc('drive_trash', { p_item_id: itemId })); navigate(backTo); }) },
  ];

  return (
    <div className={styles.viewer} data-content-layout="full-bleed">
      {/* ── Top bar ── */}
      <header className={styles.bar}>
        <Link className={styles.round} to={backTo} aria-label="Back to folder" title="Back">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <TypeIcon item={d} size="sm" />
        <div className={styles.titleBlock}>
          {editable ? (
            <button type="button" className={styles.title} title="Rename" onClick={() => setRenaming(true)}>{d.name}</button>
          ) : <span className={styles.title}>{d.name}</span>}
          <span className={styles.subtitle}>
            {kindLabel(asItem)}{d.kind === 'file' && ` · ${formatSize(d.size_bytes)}`} · Updated {new Date(d.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        </div>
        <button type="button" className={`${styles.round} ${starred ? styles.starOn : ''}`} aria-pressed={starred} aria-label={starred ? 'Remove from Starred' : 'Add to Starred'} title={starred ? 'Remove from Starred' : 'Add to Starred'}
          onClick={() => void act(() => result(platform.rpc('drive_toggle_star', { p_item_id: itemId })))}>{starred ? '★' : '☆'}</button>
        <span className={styles.barSpacer} />
        {officeFile && <button type="button" className={styles.pill} onClick={() => setEditing(true)}>{pdfFile ? (editable ? 'Fill PDF form' : 'Open PDF') : editable ? 'Open in editor' : 'Open in viewer'}</button>}
        {zipFile && editable && <button type="button" className={styles.pill} disabled={busy} onClick={() => void act(async () => { const r = await (await api('drive/unzip', { item_id: itemId })).json() as { folder_id: string }; navigate(`/drive/folder/${r.folder_id}`); })}>{busy ? 'Extracting…' : 'Extract here'}</button>}
        {aiVisible && <Link className={styles.pill} to={`/agents?source=${itemId}`}>✦ Ask an agent</Link>}
        {d.kind === 'file' && (
          <button type="button" className={styles.round} aria-label="Download" title="Download" onClick={() => { download().catch((e) => setError(errorText(e))); }}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11m0 0 5-5m-5 5-5-5M5 20h14" /></svg>
          </button>
        )}
        <button type="button" className={styles.share} onClick={() => setSharing(true)}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 11a3 3 0 1 0-3-3M8 12a3 3 0 1 0 0-.01M3 20c0-3 2.5-5 5-5s5 2 5 5M14 15.5c3 0 7 1.5 7 4.5" /></svg>
          Share
        </button>
        <button type="button" className={styles.round} aria-label="More actions" title="More actions" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 240, y: r.bottom + 6 }); }}>⋮</button>
        <span className={styles.barDivider} />
        <div className={styles.panelTabs} role="group" aria-label="Side panel">
          <button type="button" aria-pressed={panel === 'details'} aria-label="Details" title="Details" onClick={() => setPanel(panel === 'details' ? null : 'details')}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></svg>
          </button>
          <button type="button" aria-pressed={panel === 'activity'} aria-label="Activity" title="Activity and versions" onClick={() => setPanel(panel === 'activity' ? null : 'activity')}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4" /></svg>
          </button>
          <button type="button" aria-pressed={panel === 'comments'} aria-label="Comments" title="Comments" onClick={() => setPanel(panel === 'comments' ? null : 'comments')}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 5h14v10H9l-4 4z" /></svg>
            {!!detail.data?.comments.length && <span className={styles.badge}>{detail.data.comments.length}</span>}
          </button>
        </div>
      </header>

      {(error || detail.error) && <div role="alert" className={styles.alert}>{error || errorText(detail.error)}<button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      {viewingOld && (
        <div className={styles.versionNote}>
          You’re viewing an older {params.get('revision') ? 'revision' : 'version'}.
          <button type="button" onClick={() => { params.delete('version'); params.delete('revision'); setParams(params); }}>Back to current</button>
        </div>
      )}

      <div className={styles.body}>
        {/* ── Stage ── */}
        <main className={styles.stage}>
          {d.kind === 'document' && detail.data?.revisions[0] ? (
            <DocumentEditor key={params.get('revision') ?? 'current'} item={d} revision={detail.data.revisions[0]} editable={editable && !params.get('revision')} onSaved={refresh} />
          ) : d.kind === 'file' ? (
            <FilePreview item={d} versions={detail.data?.versions ?? []} onDownload={() => { download().catch((e) => setError(errorText(e))); }} />
          ) : d.kind === 'folder' ? (
            <div className={styles.stageMessage}><Link className={s.primary} to={`/drive/folder/${itemId}`}>Open folder</Link></div>
          ) : (
            <div className={styles.stageMessage}>{detail.isPending ? 'Loading document…' : 'This revision is unavailable.'}</div>
          )}
        </main>

        {/* ── Side panel ── */}
        {panel && (
          <aside className={styles.panel} aria-label={panel === 'details' ? 'Details' : panel === 'activity' ? 'Activity' : 'Comments'}>
            <nav className={styles.panelNav} role="tablist">
              {(['details', 'activity', 'comments'] as const).map((p) => (
                <button key={p} type="button" role="tab" aria-selected={panel === p} className={panel === p ? styles.panelNavOn : undefined} onClick={() => setPanel(p)}>
                  {p === 'details' ? 'Details' : p === 'activity' ? 'Activity' : `Comments${detail.data?.comments.length ? ` (${detail.data.comments.length})` : ''}`}
                </button>
              ))}
              <button type="button" className={styles.round} aria-label="Close panel" onClick={() => setPanel(null)}>×</button>
            </nav>

            {panel === 'details' && (
              <div className={styles.panelBody}>
                <section className={styles.block}>
                  <h3>Who has access</h3>
                  <div className={styles.accessRow}>
                    <span className={styles.avatars} aria-hidden="true">
                      {(access?.grants ?? []).slice(0, 4).map((g) => <span key={g.id} title={g.label}>{g.label.slice(0, 1).toUpperCase()}</span>)}
                    </span>
                    <span>{access ? `${access.audience_count} ${access.audience_count === 1 ? 'person' : 'people'} can open this` : 'Checking…'}</span>
                  </div>
                  <button type="button" className={styles.linkButton} onClick={() => setSharing(true)}>Manage access</button>
                </section>
                <section className={styles.block}>
                  <h3>File details</h3>
                  <dl className={styles.facts}>
                    <div><dt>Type</dt><dd>{kindLabel(asItem)}</dd></div>
                    {d.kind === 'file' && <div><dt>Size</dt><dd>{formatSize(d.size_bytes)}</dd></div>}
                    <div><dt>Location</dt><dd>
                      <Link to="/drive?view=my">My files</Link>
                      {detail.data?.crumbs.map((c) => <span key={c.id}> › <Link to={`/drive/folder/${c.id}`}>{c.name}</Link></span>)}
                    </dd></div>
                    <div><dt>Owner</dt><dd>{nameOf(d.owner_id)}</dd></div>
                    <div><dt>Modified</dt><dd>{new Date(d.updated_at).toLocaleString()}{d.updated_by ? ` by ${nameOf(d.updated_by)}` : ''}</dd></div>
                    <div><dt>Created</dt><dd>{new Date(d.created_at).toLocaleString()}</dd></div>
                    <div><dt>Your access</dt><dd className={styles.cap}>{access?.my_role ?? '…'}</dd></div>
                  </dl>
                  {d.description && <p className={styles.description}>{d.description}</p>}
                </section>
                <section className={styles.block}>
                  <h3>AI knowledge</h3>
                  {!detail.data?.sources.length && <p className={styles.muted}>Waiting for indexing.</p>}
                  {detail.data?.sources.map((k) => (
                    <p key={k.id} className={styles.muted}>
                      <span className={styles.status} data-status={k.status}>{k.status}</span>{' '}
                      {k.error_message ?? (k.chunk_count ? `${k.chunk_count} passages searchable by agents.` : 'Extraction runs separately from uploading.')}
                    </p>
                  ))}
                  <div className={styles.inline}>
                    <button type="button" className={styles.linkButton} onClick={() => void act(() => api('jobs/run', { workspace_id: ws }))}>Process pending work</button>
                    {editable && <button type="button" className={styles.linkButton} onClick={() => void act(async () => { await result(platform.rpc('knowledge_reindex_item', { p_item_id: itemId })); await api('jobs/run', { workspace_id: ws }); })}>Reindex</button>}
                  </div>
                </section>
              </div>
            )}

            {panel === 'activity' && (
              <div className={styles.panelBody}>
                <ol className={styles.timeline}>
                  {detail.data?.versions.map((v) => {
                    const current = v.id === d.current_version_id;
                    const shown = (params.get('version') ?? d.current_version_id) === v.id;
                    return (
                      <li key={v.id} className={shown ? styles.timelineOn : undefined}>
                        <span className={styles.dot} aria-hidden="true" />
                        <div>
                          <strong>Version {v.version_no}{current && <span className={styles.tag}>Current</span>}</strong>
                          <span>{new Date(v.created_at).toLocaleString()} · {nameOf(v.created_by)} · {formatSize(v.size_bytes)}</span>
                          {!shown && <button type="button" className={styles.linkButton} onClick={() => { params.set('version', v.id); setParams(params); }}>View this version</button>}
                        </div>
                      </li>
                    );
                  })}
                  {d.kind === 'document' && detail.data?.revisions.map((r) => (
                    <li key={r.id}>
                      <span className={styles.dot} aria-hidden="true" />
                      <div>
                        <strong>Revision {r.revision_no}{r.revision_no === d.current_revision_no && <span className={styles.tag}>Current</span>}</strong>
                        <span>{new Date(r.created_at).toLocaleString()} · {nameOf(r.created_by)}</span>
                        {r.revision_no !== d.current_revision_no && <Link className={styles.linkButton} to={`?revision=${r.id}`}>View this revision</Link>}
                      </div>
                    </li>
                  ))}
                  <li>
                    <span className={styles.dot} aria-hidden="true" />
                    <div><strong>Created</strong><span>{new Date(d.created_at).toLocaleString()} · {nameOf(d.created_by)}</span></div>
                  </li>
                </ol>
              </div>
            )}

            {panel === 'comments' && (
              <div className={`${styles.panelBody} ${styles.comments}`}>
                {!detail.data?.comments.length && <p className={styles.muted}>No comments yet.{canComment ? ' Start the conversation below.' : ''}</p>}
                {detail.data?.comments.map((c) => (
                  <article key={c.id} className={styles.comment}>
                    <header>
                      <span className={styles.commentAvatar} aria-hidden="true">{nameOf(c.author_id).slice(0, 1)}</span>
                      <strong>{nameOf(c.author_id)}</strong>
                      <time>{new Date(c.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                      {(c.author_id === userId || access?.can_manage) && (
                        <button type="button" className={styles.round} aria-label="Delete comment" title="Delete comment"
                          onClick={() => { if (window.confirm('Delete this comment?')) void act(() => result(platform.rpc('drive_delete_comment', { p_comment_id: c.id }))); }}>×</button>
                      )}
                    </header>
                    <p>{c.body}</p>
                  </article>
                ))}
                {canComment && (
                  <form className={styles.commentForm} onSubmit={(e) => { e.preventDefault(); void act(async () => { await result(platform.rpc('drive_add_comment', { p_item_id: itemId, p_body: comment })); setComment(''); }); }}>
                    <textarea aria-label="Add a comment" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} required maxLength={10000}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit(); }} />
                    <div className={styles.inline}>
                      <span className={styles.muted}>Ctrl+Enter to post</span>
                      <button className={s.primary} disabled={busy || !comment.trim()}>Comment</button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {menu && <ItemMenu at={menu} actions={moreActions} onClose={() => setMenu(null)} />}
      {renaming && <RenameDialog item={asItem} onClose={() => setRenaming(false)} onDone={refresh} />}
      {moving && <MoveDialog ws={ws} userId={userId} items={[asItem]} startFolder={d.parent_id} onClose={() => setMoving(false)} onDone={refresh} />}
      <DriveShareDialog open={sharing} onClose={() => setSharing(false)} workspaceId={ws} userId={userId} itemId={itemId} itemName={d.name} itemKind={d.kind} onChanged={refresh} />
    </div>
  );
}

function DocumentEditor({ item, revision, editable, onSaved }: { item: Row<'drive_items'>; revision: Row<'drive_document_revisions'>; editable: boolean; onSaved: () => Promise<unknown> }) {
  const [body, setBody] = useState(revision.body);
  const [savedBody, setSavedBody] = useState(revision.body);
  const [base, setBase] = useState(revision.revision_no);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const state = saving ? 'Saving…' : body === savedBody ? 'All changes saved' : 'Unsaved changes';
  const save = useCallback(async () => {
    const submitted = body;
    setSaving(true);
    setError('');
    try {
      await result(platform.rpc('drive_save_document', { p_item_id: item.id, p_base_revision_no: base, p_title: item.name, p_body: submitted }));
      setBase(base + 1);
      setSavedBody(submitted);
      await onSaved();
      void api('jobs/run', { workspace_id: item.workspace_id }).catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [body, base, item.id, item.name, item.workspace_id, onSaved]);
  useEffect(() => { if (!editable || saving || body === savedBody || error) return; const timer = setTimeout(() => void save(), 1500); return () => clearTimeout(timer); }, [body, savedBody, saving, error, editable, save]);
  return (
    <div className={styles.docWrap}>
      <div className={styles.docStatus}>
        <span>{editable ? state : 'View only'} · Markdown · Revision {base}</span>
        {editable && body !== savedBody && <button type="button" className={styles.linkButton} disabled={saving} onClick={() => void save()}>Save now</button>}
      </div>
      {error && (
        <div className={styles.alert} role="alert">
          {error} Your draft is preserved.
          <button type="button" onClick={() => { setBody(revision.body); setBase(revision.revision_no); setSavedBody(revision.body); setError(''); }}>Load latest</button>
          <button type="button" onClick={() => void result(platform.rpc('drive_create_document', { p_workspace_id: item.workspace_id, p_parent_id: item.parent_id, p_title: `${item.name} (copy)`, p_body: body })).then((d) => { location.assign(`/drive/item/${d.id}`); }).catch((e) => setError(errorText(e)))}>Save a copy</button>
        </div>
      )}
      <textarea aria-label="Document content" className={styles.paper} value={body} readOnly={!editable} placeholder={editable ? 'Start typing…' : ''} onChange={(e) => setBody(e.target.value)} />
    </div>
  );
}

function FilePreview({ item, versions, onDownload }: { item: Row<'drive_items'>; versions: Row<'drive_versions'>[]; onDownload: () => void }) {
  const [params] = useSearchParams();
  const [text, setText] = useState('');
  const [csvPage, setCsvPage] = useState(0);
  const [pdfPage, setPdfPage] = useState(Math.max(1, Number(params.get('page')) || 1));
  const [zoom, setZoom] = useState(false);
  const v = versions.find((x) => x.id === (params.get('version') ?? item.current_version_id));
  const signed = useQuery({ queryKey: ['platform', item.workspace_id, 'preview', item.id, v?.id], enabled: !!v, staleTime: 50_000, gcTime: 0, queryFn: () => result(platform.storage.from(v!.storage_bucket).createSignedUrl(v!.storage_path, 60)) });
  const url = signed.data?.signedUrl;
  const mime = v?.mime_type ?? item.mime_type ?? '';
  const pdf = mime === 'application/pdf' || /\.pdf$/i.test(item.name);
  const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);
  useEffect(() => {
    setText('');
    if (!url || !/^(text\/(plain|markdown|csv))/.test(mime) || item.size_bytes > 2_000_000) return;
    const abort = new AbortController();
    fetch(url, { signal: abort.signal }).then((r) => r.text()).then((t) => setText(t.slice(0, 100000))).catch(() => {});
    return () => abort.abort();
  }, [url, mime, item.size_bytes]);
  const csv = useMemo(() => (mime === 'text/csv' && text ? parseCsv(text, 1000) : null), [mime, text]);

  if (signed.error) return <div className={styles.stageMessage}><p>{errorText(signed.error)}</p><button className={s.button} onClick={() => void signed.refetch()}>Try again</button></div>;
  if (!url) return <div className={styles.stageMessage}>{versions.length || !item.current_version_id ? 'Loading preview…' : 'This file has no stored version yet.'}</div>;
  if (image) {
    return (
      <div className={`${styles.imageStage} ${zoom ? styles.zoomed : ''}`}>
        <img src={url} alt={item.name} onClick={() => setZoom(!zoom)} title={zoom ? 'Fit to screen' : 'Actual size'} />
      </div>
    );
  }
  if (pdf) {
    return (
      <div className={styles.pdfStage}>
        <div className={styles.pdfToolbar}>
          <label>Page <input className={styles.pageInput} type="number" min="1" inputMode="numeric" value={pdfPage} onChange={(e) => setPdfPage(Math.max(1, Number(e.target.value) || 1))} /></label>
          <a className={styles.pill} href={`${url}#page=${pdfPage}`} target="_blank" rel="noopener noreferrer">Open / print</a>
          <button type="button" className={styles.pill} onClick={() => void signed.refetch()}>Refresh link</button>
        </div>
        <iframe title={`${item.name} PDF preview`} src={`${url}#page=${pdfPage}&toolbar=1&navpanes=0`} sandbox="allow-same-origin allow-downloads" />
      </div>
    );
  }
  if (csv) {
    return (
      <div className={styles.sheet}>
        <div className={styles.sheetScroll}>
          <table>
            <thead><tr><th aria-label="Row" />{csv.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>{csv.rows.slice(csvPage * 50, csvPage * 50 + 50).map((r, i) => <tr key={i}><th>{csvPage * 50 + i + 1}</th>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <div className={styles.sheetFoot}>
          <button type="button" className={styles.pill} disabled={!csvPage} onClick={() => setCsvPage(csvPage - 1)}>Previous</button>
          <span>Rows {csvPage * 50 + 1}–{Math.min(csv.rows.length, (csvPage + 1) * 50)} of {csv.rows.length}{csv.rows.length >= 1000 ? '+ (preview limit)' : ''}</span>
          <button type="button" className={styles.pill} disabled={(csvPage + 1) * 50 >= csv.rows.length} onClick={() => setCsvPage(csvPage + 1)}>Next</button>
        </div>
      </div>
    );
  }
  if (text) return <pre className={styles.paper}>{text}</pre>;
  return (
    <div className={styles.stageMessage}>
      <TypeIcon item={item} size="lg" />
      <strong>No preview available</strong>
      <p>{isOfficeFile(item.name) ? 'Open it in the editor, or download it to use a desktop app.' : 'Download the file to open it on your computer.'}</p>
      <button type="button" className={s.primary} onClick={onDownload}>Download</button>
    </div>
  );
}
