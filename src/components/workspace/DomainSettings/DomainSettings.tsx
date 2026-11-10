import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { api, errorText } from '@/features/platform/client';
import styles from './DomainSettings.module.css';

interface Zone { id: string; name: string; status: string; name_servers: string[]; original_name_servers?: string[] }
interface RecordRow { id: string; type: string; name: string; content: string; ttl: number; proxied?: boolean }
interface State { configured: boolean; account_id?: string; tunnel_id?: string | null; default_service?: string; zones: Zone[] }
const DEFAULT_TUNNEL_SERVICE = 'http://web:8080';

export function DomainSettings() {
  const { toast } = useToast();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [credentials, setCredentials] = useState({ token: '', account: '', tunnel: '', service: DEFAULT_TUNNEL_SERVICE });
  const [domain, setDomain] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [record, setRecord] = useState({ type: 'CNAME', name: '', content: '', proxied: true });
  const [editingRecordId, setEditingRecordId] = useState('');
  const [publish, setPublish] = useState({ hostname: '', service: '' });
  const zone = useMemo(() => state?.zones.find((z) => z.id === zoneId), [state, zoneId]);

  const load = useCallback(async () => {
    try {
      const data = await (await api('domains')).json() as State;
      setState(data); setError('');
      if (!zoneId && data.zones[0]) setZoneId(data.zones[0].id);
    } catch (e) { setError(errorText(e)); }
  }, [zoneId]);

  const loadRecords = useCallback(async (id: string) => {
    if (!id) { setRecords([]); return; }
    try { setRecords(((await (await api(`domains?zone_id=${id}`)).json()) as { records: RecordRow[] }).records); }
    catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRecords(zoneId); }, [loadRecords, zoneId]);

  async function act(name: string, body: unknown, success: string) {
    setBusy(name); setError('');
    try {
      await api('domains', body);
      toast({ variant: 'success', description: success });
      await load();
      if (zoneId) await loadRecords(zoneId);
      return true;
    } catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(''); }
  }

  if (!state) return <p>{error || 'Loading domain manager…'}</p>;
  if (!state.configured) return (
    <div className={styles.stack}>
      <header><h2>Connect Cloudflare</h2><p className={styles.muted}>The token is encrypted on this server and is never returned to a browser. Use a scoped token with Zone DNS Edit, Zone Read and, for tunnel publishing, Account Cloudflare Tunnel Edit.</p></header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formGrid}>
        <Input label="Cloudflare API token" type="password" autoComplete="off" value={credentials.token} onChange={(e) => setCredentials({ ...credentials, token: e.target.value })} />
        <Input label="Account ID" value={credentials.account} onChange={(e) => setCredentials({ ...credentials, account: e.target.value })} />
        <Input label="Tunnel ID (optional)" value={credentials.tunnel} onChange={(e) => setCredentials({ ...credentials, tunnel: e.target.value })} helperText="Required only for one-click tunnel hostnames." />
        <Input label="Default tunnel service" value={credentials.service} onChange={(e) => setCredentials({ ...credentials, service: e.target.value })} helperText={`Use ${DEFAULT_TUNNEL_SERVICE} for this production stack, or an explicit custom origin such as http://host.docker.internal:3008.`} />
      </div>
      <div><Button loading={busy === 'configure'} disabled={credentials.token.trim().length < 20 || credentials.account.trim().length !== 32} onClick={() => void act('configure', { action: 'configure', api_token: credentials.token, account_id: credentials.account, tunnel_id: credentials.tunnel, default_service: credentials.service }, 'Cloudflare connected.').then((ok) => { if (ok) setCredentials({ ...credentials, token: '' }); })}>Verify &amp; connect</Button></div>
    </div>
  );

  return (
    <div className={styles.stack}>
      <header className={styles.header}><div><h2>Domains &amp; DNS</h2><p className={styles.muted}>Cloudflare account {state.account_id} · {state.tunnel_id ? 'Tunnel publishing ready' : 'DNS management ready; tunnel not configured'}</p></div><Button variant="ghost" size="sm" loading={busy === 'disconnect'} onClick={() => { if (window.confirm('Disconnect Cloudflare from Darkspace? Existing DNS records will not be changed.')) void act('disconnect', { action: 'disconnect' }, 'Cloudflare disconnected.'); }}>Disconnect</Button></header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <section className={styles.card}>
        <h3>Add a registered domain</h3><p className={styles.muted}>Darkspace creates the Cloudflare zone and imports common records. Then change the nameservers at your registrar to those shown below.</p>
        <div className={styles.inline}><Input aria-label="Domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} /><Button loading={busy === 'add'} disabled={!domain.trim()} onClick={() => void act('add', { action: 'add_domain', domain }, 'Domain added. Copy its nameservers to your registrar.').then((ok) => { if (ok) setDomain(''); })}>Add domain</Button></div>
      </section>
      <section className={styles.card}>
        <div className={styles.inline}><h3>Managed zones</h3><select className={styles.select} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{state.zones.map((z) => <option value={z.id} key={z.id}>{z.name} · {z.status}</option>)}</select></div>
        {!zone ? <p className={styles.muted}>No domains yet.</p> : <>
          <div className={`${styles.status} ${zone.status === 'active' ? styles.active : ''}`}><strong>{zone.status === 'active' ? 'Active' : 'Registrar action required'}</strong><span>{zone.status === 'active' ? 'Nameserver delegation is working.' : 'At your registrar, replace the current nameservers with:'}</span>{zone.status !== 'active' && <code>{zone.name_servers.join('\n')}</code>}</div>
          <h3>Publish through your Cloudflare tunnel</h3><p className={styles.muted}>This safely adds the hostname to the existing tunnel configuration and creates its proxied CNAME. Existing ingress routes are preserved.</p>
          <div className={styles.formGrid}><Input label="Hostname" placeholder={`app.${zone.name}`} value={publish.hostname} onChange={(e) => setPublish({ ...publish, hostname: e.target.value })} /><Input label="Origin service" placeholder={state.default_service || DEFAULT_TUNNEL_SERVICE} value={publish.service} onChange={(e) => setPublish({ ...publish, service: e.target.value })} /></div>
          <div><Button loading={busy === 'publish'} disabled={!state.tunnel_id || !publish.hostname.trim()} onClick={() => void act('publish', { action: 'publish_hostname', zone_id: zone.id, hostname: publish.hostname, service: publish.service || undefined }, 'Tunnel hostname published.').then((ok) => { if (ok) setPublish({ ...publish, hostname: '' }); })}>Publish hostname</Button></div>
        </>}
      </section>
      {zone && <section className={styles.card}>
        <h3>DNS records</h3>
        <div className={styles.recordForm}><select className={styles.select} value={record.type} onChange={(e) => setRecord({ ...record, type: e.target.value })}>{['A','AAAA','CNAME','TXT','MX','CAA'].map((x) => <option key={x}>{x}</option>)}</select><Input aria-label="Record name" placeholder="@ or subdomain" value={record.name} onChange={(e) => setRecord({ ...record, name: e.target.value })} /><Input aria-label="Record value" placeholder="Value or target" value={record.content} onChange={(e) => setRecord({ ...record, content: e.target.value })} /><label className={styles.check}><input type="checkbox" checked={record.proxied} disabled={!['A','AAAA','CNAME'].includes(record.type)} onChange={(e) => setRecord({ ...record, proxied: e.target.checked })} /> Proxied</label><Button loading={busy === 'record'} disabled={!record.name.trim() || !record.content.trim()} onClick={() => void act('record', { action: editingRecordId ? 'update_record' : 'create_record', zone_id: zone.id, record_id: editingRecordId || undefined, record: { ...record, ttl: 1 } }, editingRecordId ? 'DNS record updated.' : 'DNS record created.').then((ok) => { if (ok) { setRecord({ ...record, name: '', content: '' }); setEditingRecordId(''); } })}>{editingRecordId ? 'Update' : 'Create'}</Button></div>
        {editingRecordId && <div><Button size="sm" variant="ghost" onClick={() => { setEditingRecordId(''); setRecord({ type: 'CNAME', name: '', content: '', proxied: true }); }}>Cancel editing</Button></div>}
        <div className={styles.table}>{records.map((r) => <div className={styles.record} key={r.id}><strong>{r.type}</strong><span>{r.name}</span><code title={r.content}>{r.content}</code><span>{r.proxied ? 'Proxied' : 'DNS only'}</span><div className={styles.rowActions}><Button size="sm" variant="ghost" onClick={() => { setEditingRecordId(r.id); setRecord({ type: r.type, name: r.name, content: r.content, proxied: !!r.proxied }); }}>Edit</Button><Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => { if (window.confirm(`Delete ${r.type} ${r.name}?`)) void act(r.id, { action: 'delete_record', zone_id: zone.id, record_id: r.id }, 'DNS record deleted.'); }}>Delete</Button></div></div>)}</div>
      </section>}
    </div>
  );
}
