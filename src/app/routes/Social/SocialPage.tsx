// A compact Mixpost-style publishing desk: choose a managed brand, compose
// once, publish to several accounts, and see every target's result.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { api, errorText, platform, result } from '@/features/platform/client';
import styles from './SocialPage.module.css';

type Network = 'x' | 'linkedin' | 'facebook' | 'pinterest' | 'tiktok';
type AccountStatus = 'needs_login' | 'connected' | 'error';
type PostStatus = 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

interface Company { id: string; name: string }
interface Account {
  id: string;
  workspace_id: string;
  company_id: string | null;
  platform: Network;
  label: string;
  status: AccountStatus;
  last_error: string | null;
  connected_at: string | null;
  last_used_at: string | null;
}
interface Target {
  id: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'cancelled';
  error: string | null;
  published_at: string | null;
  social_accounts: Pick<Account, 'id' | 'label' | 'platform'> | null;
}
interface SocialPost {
  id: string;
  company_id: string | null;
  body: string;
  link: string | null;
  scheduled_at: string | null;
  status: PostStatus;
  created_at: string;
  social_post_targets: Target[];
}

const NETWORKS: Array<{ id: Network; label: string; mark: string; max: number }> = [
  { id: 'x', label: 'X', mark: 'X', max: 280 },
  { id: 'linkedin', label: 'LinkedIn', mark: 'in', max: 3000 },
  { id: 'facebook', label: 'Facebook', mark: 'f', max: 63206 },
  { id: 'pinterest', label: 'Pinterest', mark: 'P', max: 500 },
  { id: 'tiktok', label: 'TikTok', mark: '♪', max: 2200 },
];
const network = (id: Network) => NETWORKS.find((n) => n.id === id)!;
const localDateTime = (date: Date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
const when = (value: string | null) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value ?? Date.now()));

export default function SocialPage() {
  const { currentWorkspace, currentRole } = useWorkspaceContext();
  const { userId } = useAuth();
  const ws = currentWorkspace!.id;
  const admin = currentRole === 'owner' || currentRole === 'admin';
  const cache = useQueryClient();
  const { toast } = useToast();
  const base = ['platform', ws, userId, 'social'];
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [accountDialog, setAccountDialog] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scheduled, setScheduled] = useState(localDateTime(new Date(Date.now() + 60 * 60_000)));
  const [publishNow, setPublishNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'published' | 'failed'>('all');

  const companies = useQuery({
    queryKey: [...base, 'companies'],
    queryFn: (): Promise<Company[]> => result(platform.from('crm_companies').select('id,name').eq('workspace_id', ws).is('client_id', null).order('name')),
  });
  const accounts = useQuery({
    queryKey: [...base, 'accounts'],
    queryFn: (): Promise<Account[]> => result(platform.from('social_accounts').select('*').eq('workspace_id', ws).order('created_at')),
  });
  const posts = useQuery({
    queryKey: [...base, 'posts'],
    queryFn: (): Promise<SocialPost[]> => result(platform.from('social_posts')
      .select('*,social_post_targets(id,status,error,published_at,social_accounts(id,label,platform))')
      .eq('workspace_id', ws).order('created_at', { ascending: false }).limit(250)),
    refetchInterval: (query) => (query.state.data as SocialPost[] | undefined)?.some((p) => p.status === 'publishing') ? 3000 : false,
  });

  const brandAccounts = useMemo(() => (accounts.data ?? []).filter((a) => a.company_id === companyId), [accounts.data, companyId]);
  const connected = brandAccounts.filter((a) => a.status === 'connected');
  const selectedCompany = companies.data?.find((c) => c.id === companyId);
  const brandName = selectedCompany?.name ?? 'Our brand';
  const maxLength = selected.size
    ? Math.min(...brandAccounts.filter((a) => selected.has(a.id)).map((a) => network(a.platform).max))
    : Math.min(...connected.map((a) => network(a.platform).max), 10000);
  const shownPosts = (posts.data ?? []).filter((p) => p.company_id === companyId && (filter === 'all' || (filter === 'failed' ? p.status === 'failed' || p.status === 'partial' : p.status === filter)));
  const refresh = () => cache.invalidateQueries({ queryKey: base });

  useEffect(() => {
    setSelected(new Set(connected.map((a) => a.id)));
  }, [companyId, accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || !selected.size) return;
    setBusy(true);
    setError('');
    try {
      await result(platform.rpc('social_schedule_post', {
        p_workspace_id: ws,
        p_company_id: companyId,
        p_body: body.trim(),
        p_link: link.trim() || null,
        p_account_ids: [...selected],
        p_scheduled_at: publishNow ? null : new Date(scheduled).toISOString(),
      }));
      setBody('');
      setLink('');
      await refresh();
      toast({ variant: 'success', description: publishNow ? 'Post queued for publishing.' : 'Post scheduled.' });
      document.querySelector('#posts')?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError('');
    try {
      await fn();
      await refresh();
      if (message) toast({ variant: 'success', description: message });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const queryError = companies.error ?? accounts.error ?? posts.error;
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Publishing desk</p>
          <h1>Social</h1>
          <p>Write once, publish for your own brand or any company you manage, and follow every delivery.</p>
        </div>
        {admin && <button className={styles.primary} onClick={() => setAccountDialog(true)}>Connect account</button>}
      </header>

      <nav className={styles.brands} aria-label="Managed brands">
        <button className={!companyId ? styles.brandActive : styles.brand} onClick={() => setCompanyId(null)}>Our brand</button>
        {companies.data?.map((company) => (
          <button key={company.id} className={companyId === company.id ? styles.brandActive : styles.brand} onClick={() => setCompanyId(company.id)}>{company.name}</button>
        ))}
      </nav>

      {(error || queryError) && <div role="alert" className={styles.error}>{error || errorText(queryError)}</div>}

      <section id="compose" className={styles.compose}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>{brandName}</p><h2>Create a post</h2></div>
          <span className={body.length > maxLength ? styles.overLimit : styles.counter}>{body.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <textarea className={styles.editor} value={body} onChange={(event) => setBody(event.target.value)} placeholder={`What should ${brandName} share?`} aria-label="Post text" />
          <input className={styles.input} value={link} onChange={(event) => setLink(event.target.value)} type="url" placeholder="Optional link — https://…" aria-label="Post link" />
          <div className={styles.accountPicker}>
            {connected.map((account) => (
              <label key={account.id} className={selected.has(account.id) ? styles.accountSelected : styles.accountChoice}>
                <input type="checkbox" checked={selected.has(account.id)} onChange={(event) => setSelected((old) => {
                  const next = new Set(old);
                  if (event.target.checked) next.add(account.id); else next.delete(account.id);
                  return next;
                })} />
                <NetworkBadge id={account.platform} />
                <span>{account.label}</span>
              </label>
            ))}
            {!connected.length && <p className={styles.emptyInline}>{admin ? 'Connect an account for this brand to start publishing.' : 'An admin needs to connect an account for this brand.'}</p>}
          </div>
          <div className={styles.scheduleRow}>
            <label className={styles.switch}><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} /> Publish now</label>
            {!publishNow && <label className={styles.dateLabel}>Publish at <input className={styles.input} type="datetime-local" min={localDateTime(new Date())} value={scheduled} onChange={(event) => setScheduled(event.target.value)} /></label>}
            <button className={styles.primary} disabled={busy || !body.trim() || !selected.size || body.length > maxLength}>{busy ? 'Saving…' : publishNow ? 'Publish now' : 'Schedule post'}</button>
          </div>
        </form>
      </section>

      <section id="posts" className={styles.section}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>{brandName}</p><h2>Publishing history</h2></div>
          <div className={styles.filters}>
            {(['all', 'scheduled', 'published', 'failed'] as const).map((value) => <button key={value} className={filter === value ? styles.filterActive : styles.filter} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
          </div>
        </div>
        <div className={styles.posts}>
          {shownPosts.map((post) => (
            <article key={post.id} className={styles.post}>
              <div className={styles.postMain}>
                <div className={styles.postMeta}><Status value={post.status} /><span>{post.scheduled_at ? when(post.scheduled_at) : when(post.created_at)}</span></div>
                <p className={styles.postBody}>{post.body}</p>
                {post.link && <a href={post.link} target="_blank" rel="noreferrer" className={styles.postLink}>{post.link}</a>}
                <div className={styles.targets}>
                  {post.social_post_targets.map((target) => target.social_accounts && (
                    <span key={target.id} className={styles.target} title={target.error ?? undefined}><NetworkBadge id={target.social_accounts.platform} /> {target.social_accounts.label}<i data-status={target.status}>{target.status}</i></span>
                  ))}
                </div>
              </div>
              <div className={styles.postActions}>
                {post.status === 'scheduled' && <button className={styles.button} onClick={() => void act(() => result(platform.rpc('social_cancel_post', { p_post_id: post.id })), 'Post cancelled.')}>Cancel</button>}
                {(post.status === 'failed' || post.status === 'partial') && <button className={styles.button} onClick={() => void act(() => result(platform.rpc('social_schedule_post', {
                  p_workspace_id: ws,
                  p_company_id: post.company_id,
                  p_body: post.body,
                  p_link: post.link,
                  p_account_ids: post.social_post_targets.map((target) => target.social_accounts?.id).filter(Boolean),
                  p_scheduled_at: null,
                  p_post_id: post.id,
                })), 'Failed deliveries queued again.')}>Retry failed</button>}
                {post.status !== 'publishing' && <button className={styles.dangerButton} onClick={() => {
                  if (window.confirm('Delete this post and its publishing results?')) void act(() => result(platform.rpc('social_delete_post', { p_post_id: post.id })), 'Post deleted.');
                }}>Delete</button>}
              </div>
            </article>
          ))}
          {!posts.isPending && !shownPosts.length && <div className={styles.empty}>No posts here yet. Compose the first one above.</div>}
        </div>
      </section>

      <section id="accounts" className={styles.section}>
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{brandName}</p><h2>Social accounts</h2></div>{admin && <button className={styles.button} onClick={() => setAccountDialog(true)}>Add account</button>}</div>
        <div className={styles.accountGrid}>
          {brandAccounts.map((account) => (
            <article className={styles.accountCard} key={account.id}>
              <NetworkBadge id={account.platform} large />
              <div className={styles.accountInfo}><strong>{account.label}</strong><span>{network(account.platform).label}</span>{account.last_error && <small>{account.last_error}</small>}</div>
              <Status value={account.status} />
              {admin && <div className={styles.accountActions}>
                <button className={styles.button} onClick={() => setLoginAccount(account)}>{account.status === 'connected' ? 'Reconnect' : 'Connect'}</button>
                <button className={styles.iconButton} aria-label={`Remove ${account.label}`} title="Remove account" onClick={() => {
                  if (window.confirm(`Remove ${account.label}? Scheduled deliveries to it will also be removed.`)) void act(() => result(platform.from('social_accounts').delete().eq('id', account.id).eq('workspace_id', ws)), 'Account removed.');
                }}>×</button>
              </div>}
            </article>
          ))}
          {!accounts.isPending && !brandAccounts.length && <div className={styles.empty}>No accounts connected for {brandName}.</div>}
        </div>
      </section>

      <AccountDialog open={accountDialog} onClose={() => setAccountDialog(false)} ws={ws} companyId={companyId} brand={brandName} onSaved={async (account) => { setAccountDialog(false); await refresh(); setLoginAccount(account); }} />
      {loginAccount && <LoginDialog account={loginAccount} onClose={() => setLoginAccount(null)} onConnected={async () => { setLoginAccount(null); await refresh(); toast({ variant: 'success', description: `${loginAccount.label} connected.` }); }} />}
    </main>
  );
}

function NetworkBadge({ id, large = false }: { id: Network; large?: boolean }) {
  const item = network(id);
  return <span className={`${styles.network} ${large ? styles.networkLarge : ''}`} data-network={id} title={item.label}>{item.mark}</span>;
}

function Status({ value }: { value: string }) {
  return <span className={styles.status} data-status={value}>{value.replace('_', ' ')}</span>;
}

function AccountDialog({ open, onClose, ws, companyId, brand, onSaved }: { open: boolean; onClose: () => void; ws: string; companyId: string | null; brand: string; onSaved: (account: Account) => Promise<void> }) {
  const { userId } = useAuth();
  const [platformId, setPlatformId] = useState<Network>('linkedin');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const account = await result(platform.from('social_accounts').insert({ workspace_id: ws, company_id: companyId, platform: platformId, label: label.trim(), created_by: userId }).select('*').single()) as Account;
      await onSaved(account);
      setLabel('');
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return <Dialog open={open} onClose={onClose} title={`Connect an account for ${brand}`}>
    <form className={styles.dialogForm} onSubmit={(event) => void submit(event)}>
      <label>Network<select className={styles.input} value={platformId} onChange={(event) => setPlatformId(event.target.value as Network)}>{NETWORKS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Account label<input className={styles.input} required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Company page or @handle" /></label>
      <p className={styles.help}>After adding it, you will sign in through a protected browser window. Passwords are sent directly to the social network; only the encrypted login session is kept.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.dialogActions}><button type="button" className={styles.button} onClick={onClose}>Cancel</button><button className={styles.primary} disabled={busy || !label.trim()}>{busy ? 'Adding…' : 'Add and connect'}</button></div>
    </form>
  </Dialog>;
}

function LoginDialog({ account, onClose, onConnected }: { account: Account; onClose: () => void; onConnected: () => Promise<void> }) {
  const [login, setLogin] = useState<{ id: string; width: number; height: number } | null>(null);
  const [image, setImage] = useState('');
  const imageRef = useRef<HTMLImageElement>(null);
  const [typing, setTyping] = useState('');
  const [cookies, setCookies] = useState('');
  const [cookieMode, setCookieMode] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const send = useCallback(async (input: Record<string, unknown>) => {
    if (!login) return;
    await api('social/login/input', { id: login.id, input });
  }, [login]);

  const loadFrame = useCallback(async () => {
    if (!login) return;
    const response = await api(`social/login/frame?id=${encodeURIComponent(login.id)}`);
    const next = URL.createObjectURL(await response.blob());
    setImage((old) => { if (old) URL.revokeObjectURL(old); return next; });
  }, [login]);

  useEffect(() => {
    let active = true;
    void api('social/login/start', { account_id: account.id }).then(async (response) => {
      const value = await response.json();
      if (active) setLogin(value);
    }).catch((err) => active && setError(errorText(err))).finally(() => active && setBusy(false));
    return () => { active = false; };
  }, [account.id]);

  useEffect(() => {
    if (!login) return;
    void loadFrame().catch((err) => setError(errorText(err)));
    const timer = window.setInterval(() => void loadFrame().catch(() => undefined), 1400);
    return () => window.clearInterval(timer);
  }, [login, loadFrame]);

  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  const cancel = () => {
    if (login) void api('social/login/cancel', { id: login.id }).catch(() => undefined);
    onClose();
  };
  const click = (event: MouseEvent<HTMLImageElement>) => {
    if (!login) return;
    const rect = event.currentTarget.getBoundingClientRect();
    void send({ type: 'click', x: (event.clientX - rect.left) * login.width / rect.width, y: (event.clientY - rect.top) * login.height / rect.height }).then(loadFrame).catch((err) => setError(errorText(err)));
  };
  const finish = async () => {
    if (!login) return; setBusy(true); setError('');
    try { await api('social/login/finish', { id: login.id }); await onConnected(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const saveCookies = async () => {
    setBusy(true); setError('');
    try {
      await api('social/cookies', { account_id: account.id, cookies: JSON.parse(cookies) });
      if (login) await api('social/login/cancel', { id: login.id }).catch(() => undefined);
      await onConnected();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return <Dialog open onClose={cancel} title={`Sign in to ${network(account.platform).label} — ${account.label}`} size="xl">
    <div className={styles.login}>
      <div className={styles.loginNotice}>This is a live, restricted browser on your server. Click the page, then use the field below to type. Two-step verification works here too.</div>
      {!cookieMode && <>
        <div className={styles.browserFrame}>{image ? <img ref={imageRef} src={image} alt={`${network(account.platform).label} sign-in page`} onClick={click} /> : <div className={styles.browserLoading}>{busy ? 'Starting secure browser…' : 'Loading sign-in page…'}</div>}</div>
        <div className={styles.remoteControls}>
          <input className={styles.input} value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="Type into the selected field" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void send({ type: 'type', text: typing }).then(() => { setTyping(''); return send({ type: 'key', key: 'Enter' }); }).then(loadFrame).catch((err) => setError(errorText(err))); } }} />
          <button className={styles.button} onClick={() => void send({ type: 'type', text: typing }).then(() => { setTyping(''); return loadFrame(); }).catch((err) => setError(errorText(err)))}>Type</button>
          {['Tab', 'Enter', 'Backspace'].map((key) => <button key={key} className={styles.button} onClick={() => void send({ type: 'key', key }).then(loadFrame).catch((err) => setError(errorText(err)))}>{key}</button>)}
          <button className={styles.button} onClick={() => void send({ type: 'scroll', dy: 600 }).then(loadFrame)}>Scroll ↓</button>
          <button className={styles.button} onClick={() => void send({ type: 'back' }).then(loadFrame)}>Back</button>
        </div>
      </>}
      {cookieMode && <label className={styles.cookieLabel}>Cookie JSON<textarea className={styles.cookieEditor} value={cookies} onChange={(event) => setCookies(event.target.value)} placeholder='[{"name":"…","value":"…","domain":".example.com"}]' /></label>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.dialogActions}>
        <button className={styles.textButton} onClick={() => setCookieMode(!cookieMode)}>{cookieMode ? 'Use secure browser' : 'Paste exported cookies instead'}</button>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={cancel}>Cancel</button>
        {cookieMode ? <button className={styles.primary} disabled={busy || !cookies.trim()} onClick={() => void saveCookies()}>Save cookies</button> : <button className={styles.primary} disabled={busy || !login} onClick={() => void finish()}>I am signed in</button>}
      </div>
    </div>
  </Dialog>;
}
