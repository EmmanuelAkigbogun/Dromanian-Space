// A compact Mixpost-style publishing desk: choose a managed brand, compose
// once, publish to several accounts, and see every target's result.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { useAuth } from '@/hooks/useAuth';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { api, errorText, platform, result } from '@/features/platform/client';
import { composeSocialPostText } from '@/lib/socialPost';
import styles from './SocialPage.module.css';
import {
  buildCampaignBrief,
  calendarDays,
  creativePackageMarkdown,
  localDayKey,
  normalizeHashtagInput,
  socialAgentHref,
} from './socialWorkflow';

type Network = 'x' | 'linkedin' | 'facebook' | 'pinterest' | 'tiktok';
type AccountStatus = 'needs_login' | 'connected' | 'error';
type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

interface Company { id: string; name: string; drive_folder_id: string | null }
interface AssetRef { item_id: string; label: string; mime_type?: string | null }
interface BrandReadiness {
  mode: 'ready' | 'brand_kit_empty' | 'named_file_fallback' | 'brand_kit_missing' | 'drive_unavailable';
  company_drive_folder_id: string | null;
  brand_folder_id: string | null;
  asset_count: number;
  indexed_count: number;
  logo_count: number;
  can_edit: boolean;
}
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
  content_channel: Network | null;
  content_format: string | null;
  script: string | null;
  visual_brief: string | null;
  cta: string | null;
  hashtags: string[];
  asset_refs: AssetRef[];
  scheduled_at: string | null;
  status: PostStatus;
  created_at: string;
  social_post_targets: Target[];
}

interface SocialAgent { id: string }

const NETWORKS: Array<{ id: Network; label: string; mark: string; max: number }> = [
  { id: 'x', label: 'X', mark: 'X', max: 280 },
  { id: 'linkedin', label: 'LinkedIn', mark: 'in', max: 3000 },
  { id: 'facebook', label: 'Facebook', mark: 'f', max: 63206 },
  { id: 'pinterest', label: 'Pinterest', mark: 'P', max: 500 },
  { id: 'tiktok', label: 'TikTok', mark: '♪', max: 2200 },
];
const network = (id: Network) => NETWORKS.find((n) => n.id === id)!;
const FORMATS = [
  ['feed', 'Feed post'], ['carousel', 'Carousel'], ['story', 'Story'], ['reel', 'Reel'],
  ['short_video', 'Short video'], ['long_video', 'Long video'],
] as const;
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
  const [params, setParams] = useSearchParams();
  const base = ['platform', ws, userId, 'social'];
  const [companyId, setCompanyId] = useState<string | null>(params.get('company'));
  const [accountDialog, setAccountDialog] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scheduled, setScheduled] = useState(localDateTime(new Date(Date.now() + 60 * 60_000)));
  const [publishNow, setPublishNow] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [channel, setChannel] = useState<Network>('linkedin');
  const [format, setFormat] = useState('feed');
  const [script, setScript] = useState('');
  const [visualBrief, setVisualBrief] = useState('');
  const [cta, setCta] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [assetRefs, setAssetRefs] = useState<AssetRef[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [calendarView, setCalendarView] = useState<'calendar' | 'list'>('calendar');
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [goal, setGoal] = useState('Build awareness and create qualified conversations');
  const [campaignFrom, setCampaignFrom] = useState(() => localDateTime(new Date()).slice(0, 10));
  const [campaignTo, setCampaignTo] = useState(() => {
    const end = new Date(); end.setDate(end.getDate() + 30); return localDateTime(end).slice(0, 10);
  });
  const [campaignChannels, setCampaignChannels] = useState<Set<Network>>(new Set(['linkedin']));
  const [frequency, setFrequency] = useState('3 posts per week');
  const [campaignNotes, setCampaignNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'scheduled' | 'published' | 'failed'>('all');

  const companies = useQuery({
    queryKey: [...base, 'companies'],
    queryFn: (): Promise<Company[]> => result(platform.from('crm_companies').select('id,name,drive_folder_id').eq('workspace_id', ws).eq('is_client', true).is('client_id', null).order('name')),
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
  const socialAgent = useQuery({
    queryKey: [...base, 'social-agent'],
    queryFn: (): Promise<SocialAgent | null> => result(platform.from('workspace_agents').select('id').eq('workspace_id', ws).eq('template_key', 'github_social_calendar').eq('status', 'active').is('archived_at', null).maybeSingle()),
  });
  const brand = useQuery({
    queryKey: [...base, 'brand-readiness', companyId],
    enabled: Boolean(companyId),
    queryFn: (): Promise<BrandReadiness> => result(platform.rpc('social_company_brand_status', {
      p_workspace_id: ws,
      p_company_id: companyId,
    })),
  });

  const brandAccounts = useMemo(() => (accounts.data ?? []).filter((a) => a.company_id === companyId), [accounts.data, companyId]);
  const connected = brandAccounts.filter((a) => a.status === 'connected');
  const eligibleAccounts = connected.filter((account) => account.platform === channel);
  const selectedEligibleAccounts = eligibleAccounts.filter((account) => selected.has(account.id));
  const publishText = composeSocialPostText(body, cta, normalizeHashtagInput(hashtags));
  const selectedCompany = companies.data?.find((c) => c.id === companyId);
  const brandName = selectedCompany?.name ?? 'Select a managed company';
  const maxLength = selectedEligibleAccounts.length
    ? Math.min(...selectedEligibleAccounts.map((account) => network(account.platform).max))
    : network(channel).max;
  const shownPosts = (posts.data ?? []).filter((p) => p.company_id === companyId && (filter === 'all' || (filter === 'failed' ? p.status === 'failed' || p.status === 'partial' : p.status === filter)));
  const monthDays = useMemo(() => calendarDays(calendarMonth), [calendarMonth]);
  const postsByDay = useMemo(() => {
    const grouped = new Map<string, SocialPost[]>();
    for (const post of shownPosts) {
      const key = localDayKey(post.scheduled_at ?? post.created_at);
      grouped.set(key, [...(grouped.get(key) ?? []), post]);
    }
    return grouped;
  }, [shownPosts]);
  const refresh = () => cache.invalidateQueries({ queryKey: base });

  useEffect(() => {
    if (!companies.data?.length || (companyId && companies.data.some((company) => company.id === companyId))) return;
    const next = companies.data[0].id;
    setCompanyId(next);
    setParams((current) => { const value = new URLSearchParams(current); value.set('company', next); return value; }, { replace: true });
  }, [companies.data, companyId, setParams]);

  useEffect(() => {
    setSelected(new Set((accounts.data ?? [])
      .filter((account) => account.company_id === companyId
        && account.status === 'connected'
        && account.platform === channel)
      .map((account) => account.id)));
  }, [accounts.data, channel, companyId]);

  const resetComposer = () => {
    setBody(''); setLink(''); setDraftId(null); setChannel('linkedin'); setFormat('feed');
    setScript(''); setVisualBrief(''); setCta(''); setHashtags(''); setAssetRefs([]); setComposeOpen(false);
  };

  const reviewDraft = (post: SocialPost) => {
    const nextChannel = post.content_channel ?? 'linkedin';
    setBody(post.body);
    setLink(post.link ?? '');
    setDraftId(post.id);
    setChannel(nextChannel);
    setSelected(new Set(connected.filter((account) => account.platform === nextChannel).map((account) => account.id)));
    setFormat(post.content_format ?? 'feed');
    setScript(post.script ?? '');
    setVisualBrief(post.visual_brief ?? '');
    setCta(post.cta ?? '');
    setHashtags((post.hashtags ?? []).map((tag) => `#${tag}`).join(' '));
    setAssetRefs(Array.isArray(post.asset_refs) ? post.asset_refs : []);
    setPublishNow(false);
    if (post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now()) setScheduled(localDateTime(new Date(post.scheduled_at)));
    setComposeOpen(true);
    window.setTimeout(() => document.querySelector('#review-draft')?.scrollIntoView({ behavior: 'smooth' }), 0);
  };

  const saveDraft = async (showToast = true) => {
    if (!draftId) return;
    await result(platform.rpc('social_update_draft', {
      p_post_id: draftId,
      p_body: body.trim(),
      p_link: link.trim() || null,
      p_channel: channel,
      p_format: format,
      p_script: script.trim() || null,
      p_visual_brief: visualBrief.trim() || null,
      p_cta: cta.trim() || null,
      p_hashtags: normalizeHashtagInput(hashtags),
      p_asset_refs: assetRefs,
    }));
    await refresh();
    if (showToast) toast({ variant: 'success', description: 'Draft review saved. Nothing was published.' });
  };

  const campaignBrief = selectedCompany ? buildCampaignBrief({
    company: selectedCompany.name,
    goal,
    from: campaignFrom,
    to: campaignTo,
    channels: [...campaignChannels].map((id) => network(id).label),
    frequency,
    notes: campaignNotes,
  }) : '';
  const agentHref = selectedCompany && socialAgent.data
    ? socialAgentHref(socialAgent.data.id, selectedCompany.id, campaignBrief)
    : null;

  const createBrandFolder = async () => {
    if (!selectedCompany?.drive_folder_id) return;
    await act(async () => {
      await result(platform.rpc('drive_create_folder', {
        p_workspace_id: ws,
        p_parent_id: selectedCompany.drive_folder_id,
        p_name: 'Brand kit',
      }));
      await brand.refetch();
    }, 'Brand kit folder created. Add logos and brand guidance in Drive.');
  };

  const exportCreativePackage = () => {
    if (!selectedCompany) return;
    const markdown = creativePackageMarkdown({
      company: selectedCompany.name, channel, format, scheduledAt: scheduled,
      caption: body, script, visualBrief, cta,
      hashtags: normalizeHashtagInput(hashtags), assets: assetRefs, link,
    });
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedCompany.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'brand'}-social-creative.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const eligibleIds = new Set(eligibleAccounts.map((account) => account.id));
    const targetAccountIds = [...selected].filter((id) => eligibleIds.has(id));
    if (!companyId || !body.trim()) return;
    if (!targetAccountIds.length) {
      setError(`Choose a connected ${network(channel).label} account before scheduling or publishing.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (draftId) await saveDraft(false);
      await result(platform.rpc('social_schedule_post', {
        p_workspace_id: ws,
        p_company_id: companyId,
        p_body: body.trim(),
        p_link: link.trim() || null,
        p_account_ids: targetAccountIds,
        p_scheduled_at: publishNow ? null : new Date(scheduled).toISOString(),
        p_post_id: draftId,
      }));
      resetComposer();
      await refresh();
      toast({ variant: 'success', description: publishNow ? 'Approved and queued for publishing.' : 'Approved and scheduled.' });
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

  const queryError = companies.error ?? accounts.error ?? posts.error ?? brand.error ?? socialAgent.error;
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Company content workflow</p>
          <h1>Social calendar</h1>
          <p>Choose one company, generate from its Brand kit, review every post, then schedule it explicitly.</p>
        </div>
        {admin && companyId && <button className={styles.primary} onClick={() => setAccountDialog(true)}>Connect account</button>}
      </header>

      <nav className={styles.brands} aria-label="Managed brands">
        {companies.data?.map((company) => (
          <button key={company.id} className={companyId === company.id ? styles.brandActive : styles.brand} onClick={() => {
            setCompanyId(company.id);
            setParams((current) => { const value = new URLSearchParams(current); value.set('company', company.id); return value; });
            resetComposer();
          }}>{company.name}</button>
        ))}
      </nav>

      {(error || queryError) && <div role="alert" className={styles.error}>{error || errorText(queryError)}</div>}

      {!companies.isPending && !companies.data?.length && (
        <section className={styles.emptyState}>
          <h2>Add a managed company first</h2>
          <p>Social calendars are company-scoped so CRM data, Drive files and brand assets can never be mixed.</p>
          <Link className={styles.primary} to="/crm">Open CRM</Link>
        </section>
      )}

      {selectedCompany && <>
        <section className={styles.readiness} aria-labelledby="brand-readiness-title">
          <div className={styles.stepBadge}>1</div>
          <div className={styles.readinessMain}>
            <p className={styles.eyebrow}>{selectedCompany.name}</p>
            <h2 id="brand-readiness-title">Brand and publishing readiness</h2>
            {brand.isPending ? <p className={styles.help}>Checking the company Drive folder...</p> : brand.data && <p className={styles.help}>
              {brand.data.mode === 'ready' && `Brand kit ready: ${brand.data.asset_count} ${brand.data.asset_count === 1 ? 'asset' : 'assets'}, ${brand.data.indexed_count} indexed for written guidance.`}
              {brand.data.mode === 'brand_kit_empty' && 'Brand kit exists but is empty. Add logos, voice, colors, fonts and visual guidance.'}
              {brand.data.mode === 'named_file_fallback' && `Using ${brand.data.asset_count} clearly named company brand files temporarily. Move approved assets into Brand kit.`}
              {brand.data.mode === 'brand_kit_missing' && 'Brand kit is missing. Create it in the company Drive folder before asking for on-brand output.'}
              {brand.data.mode === 'drive_unavailable' && 'The company Drive folder is unavailable to you.'}
            </p>}
            <div className={styles.readinessStats}>
              <span><strong>{brand.data?.asset_count ?? 0}</strong> brand {(brand.data?.asset_count ?? 0) === 1 ? 'asset' : 'assets'}</span>
              <span><strong>{brand.data?.logo_count ?? 0}</strong> logo {(brand.data?.logo_count ?? 0) === 1 ? 'file' : 'files'}</span>
              <span><strong>{connected.length}</strong> connected accounts</span>
            </div>
          </div>
          <div className={styles.readinessActions}>
            {brand.data?.brand_folder_id && <Link className={styles.button} to={`/drive/folder/${brand.data.brand_folder_id}`}>Open Brand kit</Link>}
            {!brand.data?.brand_folder_id && brand.data?.company_drive_folder_id && <Link className={styles.button} to={`/drive/folder/${brand.data.company_drive_folder_id}`}>Open company Drive</Link>}
            {brand.data?.mode === 'brand_kit_missing' && brand.data.can_edit && <button className={styles.button} onClick={() => void createBrandFolder()}>Create Brand kit folder</button>}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="campaign-title">
          <div className={styles.sectionHeading}>
            <div className={styles.headingWithStep}><span className={styles.stepBadge}>2</span><div><p className={styles.eyebrow}>{brandName}</p><h2 id="campaign-title">Plan the calendar</h2></div></div>
            <span className={styles.help}>The agent opens with this brief filled in. You still press Send.</span>
          </div>
          <div className={styles.campaignGrid}>
            <label className={styles.fieldWide}>Campaign goal<input className={styles.input} maxLength={500} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
            <label>From<input className={styles.input} type="date" value={campaignFrom} onChange={(event) => setCampaignFrom(event.target.value)} /></label>
            <label>To<input className={styles.input} type="date" min={campaignFrom} value={campaignTo} onChange={(event) => setCampaignTo(event.target.value)} /></label>
            <label>Frequency<select className={styles.input} value={frequency} onChange={(event) => setFrequency(event.target.value)}><option>2 posts per week</option><option>3 posts per week</option><option>5 posts per week</option><option>1 post per day</option></select></label>
            <fieldset className={styles.channelField}><legend>Channels</legend><div className={styles.channelChoices}>{NETWORKS.map((item) => <label key={item.id} className={campaignChannels.has(item.id) ? styles.channelSelected : styles.channelChoice}><input type="checkbox" checked={campaignChannels.has(item.id)} onChange={(event) => setCampaignChannels((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} /><NetworkBadge id={item.id} />{item.label}</label>)}</div></fieldset>
            <label className={styles.fieldWide}>Notes or offer<textarea className={styles.notes} maxLength={800} value={campaignNotes} onChange={(event) => setCampaignNotes(event.target.value)} placeholder="Audience, offer, launch, exclusions or required topics" /></label>
          </div>
          <div className={styles.campaignActions}>
            {agentHref && goal.trim() && campaignChannels.size ? <Link className={styles.primary} to={agentHref}>Generate with Social Media Manager</Link> : <button className={styles.primary} disabled>Complete the brief to generate</button>}
            <span>Generation creates reviewable drafts only. It cannot publish.</span>
          </div>
        </section>
      </>}

      {selectedCompany && <section id="posts" className={styles.section}>
        <div className={styles.sectionHeading}>
          <div className={styles.headingWithStep}><span className={styles.stepBadge}>3</span><div><p className={styles.eyebrow}>{brandName}</p><h2>Calendar and drafts</h2></div></div>
          <div className={styles.viewControls}>
            <div className={styles.filters}>{(['all', 'draft', 'scheduled', 'published', 'failed'] as const).map((value) => <button key={value} className={filter === value ? styles.filterActive : styles.filter} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
            <div className={styles.segmented}><button className={calendarView === 'calendar' ? styles.segmentActive : styles.segment} onClick={() => setCalendarView('calendar')}>Calendar</button><button className={calendarView === 'list' ? styles.segmentActive : styles.segment} onClick={() => setCalendarView('list')}>List</button></div>
          </div>
        </div>
        {calendarView === 'calendar' && <>
          <div className={styles.monthNav}><button className={styles.button} aria-label="Previous month" onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}>&lsaquo;</button><strong>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarMonth)}</strong><button className={styles.button} aria-label="Next month" onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}>&rsaquo;</button></div>
          <div className={styles.weekdays}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className={styles.calendarGrid}>{monthDays.map((day) => {
            const key = localDayKey(day); const dayPosts = postsByDay.get(key) ?? [];
            return <div key={key} className={day.getMonth() === calendarMonth.getMonth() ? styles.calendarDay : styles.calendarDayMuted}><span className={styles.dayNumber}>{day.getDate()}</span>{dayPosts.slice(0, 3).map((post) => {
              const summary = <>{post.content_channel && <NetworkBadge id={post.content_channel} />}<span>{post.body}</span></>;
              return post.status === 'draft'
                ? <button key={post.id} className={styles.calendarPost} data-status={post.status} onClick={() => reviewDraft(post)} title={`Review draft: ${post.body}`}>{summary}</button>
                : <div key={post.id} className={styles.calendarPost} data-status={post.status} title={post.body}>{summary}</div>;
            })}{dayPosts.length > 3 && <small>+{dayPosts.length - 3} more</small>}</div>;
          })}</div>
          {!posts.isPending && !shownPosts.length && <div className={styles.emptyCalendar}>No drafts on this calendar yet. Generate the first company campaign above.</div>}
        </>}
        {calendarView === 'list' && <div className={styles.posts}>
          {shownPosts.map((post) => (
            <article key={post.id} className={styles.post}>
              <div className={styles.postMain}>
                <div className={styles.postMeta}><Status value={post.status} />{post.content_channel && <NetworkBadge id={post.content_channel} />}<span>{post.scheduled_at ? when(post.scheduled_at) : when(post.created_at)}</span>{post.content_format && <span>{post.content_format.replace('_', ' ')}</span>}</div>
                <p className={styles.postBody}>{post.body}</p>
                {(post.cta || post.hashtags?.length) && <p className={styles.postWorkflow}>{post.cta && <><strong>CTA:</strong> {post.cta} </>}{post.hashtags?.map((tag) => `#${tag}`).join(' ')}</p>}
                {post.asset_refs?.length > 0 && <div className={styles.assets}>{post.asset_refs.map((asset) => <Link key={asset.item_id} to={`/drive/item/${asset.item_id}`}>{asset.label}</Link>)}</div>}
                {post.link && <a href={post.link} target="_blank" rel="noreferrer" className={styles.postLink}>{post.link}</a>}
                <div className={styles.targets}>
                  {post.social_post_targets.map((target) => target.social_accounts && (
                    <span key={target.id} className={styles.target} title={target.error ?? undefined}><NetworkBadge id={target.social_accounts.platform} /> {target.social_accounts.label}<i data-status={target.status}>{target.status}</i></span>
                  ))}
                </div>
              </div>
              <div className={styles.postActions}>
                {post.status === 'draft' && <button className={styles.primary} onClick={() => reviewDraft(post)}>Review draft</button>}
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
          {!posts.isPending && !shownPosts.length && <div className={styles.empty}>No posts for this company yet. Complete the campaign brief above and ask the Social Media Manager to prepare drafts.</div>}
        </div>}
      </section>}

      {composeOpen && selectedCompany && <section id="review-draft" className={styles.compose}>
        <div className={styles.sectionHeading}>
          <div className={styles.headingWithStep}><span className={styles.stepBadge}>4</span><div><p className={styles.eyebrow}>{brandName}</p><h2>Review draft</h2></div></div>
          <div className={styles.reviewHeaderActions}><span className={publishText.length > maxLength ? styles.overLimit : styles.counter}>{publishText.length.toLocaleString()} / {maxLength.toLocaleString()}</span><button type="button" className={styles.button} onClick={resetComposer}>Close</button></div>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className={styles.reviewGrid}>
            <label>Channel<select className={styles.input} value={channel} onChange={(event) => {
              const nextChannel = event.target.value as Network;
              setChannel(nextChannel);
              setSelected(new Set(connected.filter((account) => account.platform === nextChannel).map((account) => account.id)));
            }}>{NETWORKS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label>Format<select className={styles.input} value={format} onChange={(event) => setFormat(event.target.value)}>{FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className={styles.fieldWide}>Caption<textarea className={styles.editor} value={body} onChange={(event) => setBody(event.target.value)} placeholder={`What should ${brandName} share?`} aria-label="Post caption" /></label>
            <label className={styles.fieldWide}>Script<textarea className={styles.notesTall} value={script} onChange={(event) => setScript(event.target.value)} placeholder="Spoken words, scenes and on-screen text for video content" /></label>
            <label className={styles.fieldWide}>Visual brief<textarea className={styles.notesTall} value={visualBrief} onChange={(event) => setVisualBrief(event.target.value)} placeholder="Composition, shots, layout, colors, typography and asset usage" /></label>
            <label>CTA<input className={styles.input} maxLength={500} value={cta} onChange={(event) => setCta(event.target.value)} /></label>
            <label>Hashtags<input className={styles.input} value={hashtags} onChange={(event) => setHashtags(event.target.value)} placeholder="#brand #campaign" /></label>
          </div>
          <input className={styles.input} value={link} onChange={(event) => setLink(event.target.value)} type="url" placeholder="Optional link - https://..." aria-label="Post link" />
          <div className={styles.assetPanel}><div><strong>Drive assets</strong><p>The agent can only select files inside this company&apos;s Drive scope.</p></div>{assetRefs.length ? <div className={styles.assetList}>{assetRefs.map((asset) => <span key={asset.item_id}><Link to={`/drive/item/${asset.item_id}`}>{asset.label}</Link><button type="button" aria-label={`Remove ${asset.label}`} onClick={() => setAssetRefs((current) => current.filter((item) => item.item_id !== asset.item_id))}>&times;</button></span>)}</div> : <span className={styles.help}>No Drive assets selected.</span>}</div>
          <div className={styles.reviewTools}><button type="button" className={styles.button} onClick={exportCreativePackage}>Export creative package</button><button type="button" className={styles.button} disabled={busy || !body.trim()} onClick={() => void act(() => saveDraft(), undefined)}>Save review</button><span>Export is a file handoff; it does not claim a Canva design was created.</span></div>
          <div className={styles.accountPicker}>
            {eligibleAccounts.map((account) => (
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
            {!eligibleAccounts.length && <p className={styles.emptyInline}>{admin ? `Connect a ${network(channel).label} account for this company before scheduling.` : `An admin needs to connect a ${network(channel).label} account for this company.`}</p>}
          </div>
          <div className={styles.scheduleRow}>
            <label className={styles.switch}><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} /> Publish immediately after approval</label>
            {!publishNow && <label className={styles.dateLabel}>Schedule for <input className={styles.input} type="datetime-local" min={localDateTime(new Date())} value={scheduled} onChange={(event) => setScheduled(event.target.value)} /></label>}
            <button className={styles.primary} disabled={busy || !body.trim() || !selectedEligibleAccounts.length || publishText.length > maxLength}>{busy ? 'Saving...' : publishNow ? 'Approve and publish' : 'Approve and schedule'}</button>
          </div>
        </form>
      </section>}

      {selectedCompany && <section id="accounts" className={styles.section}>
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
                }}>&times;</button>
              </div>}
            </article>
          ))}
          {!accounts.isPending && !brandAccounts.length && <div className={styles.empty}>No accounts connected for {brandName}.</div>}
        </div>
      </section>}

      <AccountDialog open={accountDialog && Boolean(companyId)} onClose={() => setAccountDialog(false)} ws={ws} companyId={companyId} brand={brandName} onSaved={async (account) => { setAccountDialog(false); await refresh(); setLoginAccount(account); }} />
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
