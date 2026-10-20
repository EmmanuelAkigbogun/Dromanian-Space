/**
 * Browser client for the Dromanian server.
 *
 * Data requests use the app's same-origin /api/db proxy, authentication uses
 * HttpOnly server sessions, files live on the server's mounted storage disk,
 * and live events use one same-origin SSE connection. No third-party backend
 * SDK or public database credential is shipped to the browser.
 */

export interface PlatformUser {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformSession {
  access_token: string;
  expires_at: number;
  expires_in: number;
  token_type: 'bearer';
  user: PlatformUser;
}

export interface PlatformError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
  status?: number;
}

type Result<T = any> = { data: T | null; error: PlatformError | null; count?: number | null };
type FilterValue = string | number | boolean | null | readonly unknown[] | Record<string, unknown>;

function errorFrom(value: unknown, status?: number): PlatformError {
  const raw = value as { message?: string; code?: string; details?: string; hint?: string; error?: { message?: string; code?: string } } | null;
  return {
    message: raw?.message ?? raw?.error?.message ?? `Request failed${status ? ` (${status})` : ''}.`,
    code: raw?.code ?? raw?.error?.code,
    details: raw?.details,
    hint: raw?.hint,
    status,
  };
}

function encodeFilter(value: FilterValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `{${value.map((v) => String(v).replaceAll('"', '\\"')).join(',')}}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

class DataQuery<T = any> implements PromiseLike<Result<T>> {
  private method = 'GET';
  private body: unknown;
  private readonly params = new URLSearchParams();
  private readonly headers = new Headers();
  private signal?: AbortSignal;
  private unwrap: 'single' | 'maybe' | null = null;

  private readonly path: string;
  constructor(path: string) { this.path = path; }

  select(columns = '*', options?: { count?: string; head?: boolean }): this {
    this.params.set('select', columns);
    if (options?.count) this.prefer(`count=${options.count}`);
    if (options?.head) this.method = 'HEAD';
    if (this.method !== 'GET' && this.method !== 'HEAD') this.prefer('return=representation');
    return this;
  }

  insert(values: unknown, options?: { count?: string; defaultToNull?: boolean }): this {
    this.method = 'POST';
    this.body = values;
    if (options?.count) this.prefer(`count=${options.count}`);
    if (options?.defaultToNull === false) this.prefer('missing=default');
    return this;
  }

  upsert(values: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string; defaultToNull?: boolean }): this {
    this.method = 'POST';
    this.body = values;
    this.prefer(`resolution=${options?.ignoreDuplicates ? 'ignore' : 'merge'}-duplicates`);
    if (options?.onConflict) this.params.set('on_conflict', options.onConflict);
    if (options?.count) this.prefer(`count=${options.count}`);
    if (options?.defaultToNull === false) this.prefer('missing=default');
    return this;
  }

  update(values: unknown, options?: { count?: string }): this {
    this.method = 'PATCH';
    this.body = values;
    if (options?.count) this.prefer(`count=${options.count}`);
    return this;
  }

  delete(options?: { count?: string }): this {
    this.method = 'DELETE';
    if (options?.count) this.prefer(`count=${options.count}`);
    return this;
  }

  eq(column: string, value: FilterValue): this { return this.filter(column, 'eq', value); }
  neq(column: string, value: FilterValue): this { return this.filter(column, 'neq', value); }
  gt(column: string, value: FilterValue): this { return this.filter(column, 'gt', value); }
  gte(column: string, value: FilterValue): this { return this.filter(column, 'gte', value); }
  lt(column: string, value: FilterValue): this { return this.filter(column, 'lt', value); }
  lte(column: string, value: FilterValue): this { return this.filter(column, 'lte', value); }
  like(column: string, value: string): this { return this.filter(column, 'like', value); }
  ilike(column: string, value: string): this { return this.filter(column, 'ilike', value); }
  is(column: string, value: null | boolean): this { return this.filter(column, 'is', value); }
  contains(column: string, value: FilterValue): this { return this.filter(column, 'cs', value); }
  containedBy(column: string, value: FilterValue): this { return this.filter(column, 'cd', value); }
  overlaps(column: string, value: FilterValue): this { return this.filter(column, 'ov', value); }
  in(column: string, values: readonly unknown[]): this {
    const encoded = values.map((v) => `"${String(v).replaceAll('"', '\\"')}"`).join(',');
    this.params.append(column, `in.(${encoded})`);
    return this;
  }
  match(query: Record<string, FilterValue>): this {
    for (const [column, value] of Object.entries(query)) this.eq(column, value);
    return this;
  }
  filter(column: string, operator: string, value: FilterValue): this {
    this.params.append(column, `${operator}.${encodeFilter(value)}`);
    return this;
  }
  not(column: string, operator: string, value: FilterValue): this {
    this.params.append(column, `not.${operator}.${encodeFilter(value)}`);
    return this;
  }
  or(filters: string, options?: { foreignTable?: string; referencedTable?: string }): this {
    const relation = options?.foreignTable ?? options?.referencedTable;
    this.params.append(relation ? `${relation}.or` : 'or', `(${filters})`);
    return this;
  }
  textSearch(column: string, query: string, options?: { config?: string; type?: 'plain' | 'phrase' | 'websearch' }): this {
    const op = options?.type === 'phrase' ? 'phfts' : options?.type === 'websearch' ? 'wfts' : options?.type === 'plain' ? 'plfts' : 'fts';
    this.params.append(column, `${op}${options?.config ? `(${options.config})` : ''}.${query}`);
    return this;
  }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }): this {
    const relation = options?.foreignTable ?? options?.referencedTable;
    const value = `${column}.${options?.ascending === false ? 'desc' : 'asc'}${options?.nullsFirst === undefined ? '' : options.nullsFirst ? '.nullsfirst' : '.nullslast'}`;
    this.params.append(relation ? `${relation}.order` : 'order', value);
    return this;
  }
  limit(count: number, options?: { foreignTable?: string; referencedTable?: string }): this {
    const relation = options?.foreignTable ?? options?.referencedTable;
    this.params.set(relation ? `${relation}.limit` : 'limit', String(count));
    return this;
  }
  range(from: number, to: number, options?: { foreignTable?: string; referencedTable?: string }): this {
    const relation = options?.foreignTable ?? options?.referencedTable;
    if (relation) {
      this.params.set(`${relation}.offset`, String(from));
      this.params.set(`${relation}.limit`, String(to - from + 1));
    } else {
      this.params.set('offset', String(from));
      this.params.set('limit', String(to - from + 1));
    }
    return this;
  }
  single(): this { this.unwrap = 'single'; this.headers.set('accept', 'application/vnd.pgrst.object+json'); return this; }
  maybeSingle(): this { this.unwrap = 'maybe'; this.headers.set('accept', 'application/vnd.pgrst.object+json'); return this; }
  abortSignal(signal: AbortSignal): this { this.signal = signal; return this; }
  returns<U>(): DataQuery<U> { return this as unknown as DataQuery<U>; }
  throwOnError(): this { return this; }

  private prefer(value: string): void {
    const current = this.headers.get('prefer');
    if (!current?.includes(value)) this.headers.set('prefer', current ? `${current},${value}` : value);
  }

  private async execute(): Promise<Result<T>> {
    const query = this.params.toString();
    if (this.body !== undefined && !this.headers.has('content-type')) {
      this.headers.set('content-type', 'application/json');
    }
    const response = await fetch(`/api/db/${this.path}${query ? `?${query}` : ''}`, {
      method: this.method,
      headers: this.headers,
      credentials: 'same-origin',
      body: this.body === undefined ? undefined : JSON.stringify(this.body),
      signal: this.signal,
    });
    const raw = response.status === 204 || this.method === 'HEAD' ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (this.unwrap === 'maybe' && response.status === 406 && raw?.code === 'PGRST116') return { data: null, error: null, count: null };
      return { data: null, error: errorFrom(raw, response.status), count: null };
    }
    const contentRange = response.headers.get('content-range');
    const count = contentRange?.includes('/') ? Number(contentRange.split('/')[1]) : null;
    return { data: raw as T, error: null, count: Number.isFinite(count) ? count : null };
  }

  then<TResult1 = Result<T>, TResult2 = never>(
    onfulfilled?: ((value: Result<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class AuthClient {
  private listeners = new Set<(event: string, session: PlatformSession | null) => void>();

  private async request(path: string, body?: unknown): Promise<{ data: { user?: PlatformUser; session?: PlatformSession | null }; error: PlatformError | null }> {
    const response = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { data: {}, error: errorFrom(data, response.status) };
    return { data, error: null };
  }

  async getSession(): Promise<{ data: { session: PlatformSession | null }; error: PlatformError | null }> {
    const result = await this.request('session');
    return { data: { session: result.data.session ?? null }, error: result.error };
  }
  async getUser(): Promise<{ data: { user: PlatformUser | null }; error: PlatformError | null }> {
    const result = await this.getSession();
    return { data: { user: result.data.session?.user ?? null }, error: result.error };
  }
  async signUp(credentials: { email: string; password: string; options?: unknown }): Promise<{ data: { user: PlatformUser | null; session: PlatformSession | null }; error: PlatformError | null }> {
    const result = await this.request('signup', credentials);
    if (!result.error) this.emit('SIGNED_IN', result.data.session ?? null);
    return { data: { user: result.data.user ?? result.data.session?.user ?? null, session: result.data.session ?? null }, error: result.error };
  }
  async signInWithPassword(credentials: { email: string; password: string }): Promise<{ data: { user: PlatformUser | null; session: PlatformSession | null }; error: PlatformError | null }> {
    const result = await this.request('signin', credentials);
    if (!result.error) this.emit('SIGNED_IN', result.data.session ?? null);
    return { data: { user: result.data.session?.user ?? null, session: result.data.session ?? null }, error: result.error };
  }
  async signOut(): Promise<{ error: PlatformError | null }> {
    const result = await this.request('signout', {});
    if (!result.error) this.emit('SIGNED_OUT', null);
    return { error: result.error };
  }
  async resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Promise<{ data: object | null; error: PlatformError | null }> {
    const result = await this.request('forgot-password', { email, redirectTo: options?.redirectTo });
    return { data: result.error ? null : {}, error: result.error };
  }
  async updateUser(attributes: { password?: string; data?: Record<string, unknown> }): Promise<{ data: { user: PlatformUser | null }; error: PlatformError | null }> {
    const result = await this.request('user', attributes);
    if (!result.error) {
      const session = result.data.session ?? null;
      this.emit('USER_UPDATED', session);
    }
    return { data: { user: result.data.user ?? result.data.session?.user ?? null }, error: result.error };
  }
  async setSession(tokens: { access_token: string; refresh_token: string }): Promise<{ data: { session: PlatformSession | null }; error: PlatformError | null }> {
    const result = await this.request('recover', tokens);
    if (!result.error) this.emit('PASSWORD_RECOVERY', result.data.session ?? null);
    return { data: { session: result.data.session ?? null }, error: result.error };
  }
  onAuthStateChange(callback: (event: string, session: PlatformSession | null) => void) {
    this.listeners.add(callback);
    return { data: { subscription: { unsubscribe: () => this.listeners.delete(callback) } } };
  }
  private emit(event: string, session: PlatformSession | null): void {
    for (const listener of this.listeners) listener(event, session);
  }
}

interface LiveHandler { kind: string; filter: Record<string, unknown>; callback: (payload: any) => void }

function matchesPostgresFilter(expression: unknown, payload: any): boolean {
  if (typeof expression !== 'string' || !expression) return true;
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)=(eq|neq)\.(.*)$/.exec(expression);
  if (!match) return false;
  const row = payload?.new && Object.keys(payload.new).length ? payload.new : payload?.old;
  const actual = row?.[match[1]];
  return match[2] === 'eq' ? String(actual) === match[3] : String(actual) !== match[3];
}

class LiveChannel {
  private handlers: LiveHandler[] = [];
  readonly topic: string;
  private readonly owner: LiveClient;
  constructor(topic: string, owner: LiveClient) { this.topic = topic; this.owner = owner; }
  on(kind: string, filter: Record<string, unknown>, callback: (payload: any) => void): this {
    this.handlers.push({ kind, filter, callback });
    return this;
  }
  subscribe(callback?: (status: string) => void): this {
    this.owner.add(this);
    queueMicrotask(() => callback?.('SUBSCRIBED'));
    return this;
  }
  unsubscribe(): Promise<'ok'> { return this.owner.remove(this); }
  async send(message: { type: string; event: string; payload: unknown }): Promise<string> {
    const response = await fetch('/api/events/broadcast', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: this.topic, ...message }),
    });
    return response.ok ? 'ok' : 'error';
  }
  async track(payload: unknown): Promise<string> {
    const response = await fetch('/api/events/presence', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: this.topic, payload }),
    });
    return response.ok ? 'ok' : 'error';
  }
  presenceState(): Record<string, unknown[]> { return this.owner.presence(this.topic); }
  dispatch(event: any): void {
    for (const handler of this.handlers) {
      if (handler.kind !== event.kind) continue;
      if (handler.kind === 'broadcast' && handler.filter.event !== event.event) continue;
      if (handler.kind === 'presence' && handler.filter.event !== event.event) continue;
      if (handler.kind === 'postgres_changes') {
        if (handler.filter.table && handler.filter.table !== event.table) continue;
        if (handler.filter.event && handler.filter.event !== '*' && handler.filter.event !== event.event) continue;
        if (!matchesPostgresFilter(handler.filter.filter, event.payload)) continue;
      }
      handler.callback(event.payload);
    }
  }
}

class LiveClient {
  private channels = new Set<LiveChannel>();
  private states: Record<string, Record<string, unknown[]>> = {};
  private source: EventSource | null = null;
  channel(topic: string): LiveChannel { return new LiveChannel(topic, this); }
  add(channel: LiveChannel): void { this.channels.add(channel); this.connect(); }
  remove(channel: LiveChannel): Promise<'ok'> { this.channels.delete(channel); return Promise.resolve('ok'); }
  removeAll(): Promise<'ok'> { this.channels.clear(); this.source?.close(); this.source = null; return Promise.resolve('ok'); }
  presence(topic: string): Record<string, unknown[]> { return this.states[topic] ?? {}; }
  private connect(): void {
    if (this.source) return;
    this.source = new EventSource('/api/events', { withCredentials: true });
    this.source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.kind === 'presence_state') this.states[event.topic] = event.payload;
        for (const channel of this.channels) if (!event.topic || channel.topic === event.topic || event.kind === 'postgres_changes') channel.dispatch(event);
      } catch { /* ignore malformed event */ }
    };
    this.source.onerror = () => { /* EventSource reconnects automatically */ };
  }
}

class StorageBucket {
  private readonly bucket: string;
  constructor(bucket: string) { this.bucket = bucket; }
  async upload(path: string, file: Blob | ArrayBuffer, options?: { contentType?: string; upsert?: boolean }): Promise<Result<{ path: string }>> {
    const response = await fetch(`/api/storage/object/${encodeURIComponent(this.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': options?.contentType ?? (file instanceof Blob ? file.type : 'application/octet-stream'), 'x-upsert': options?.upsert ? 'true' : 'false' }, body: file,
    });
    const data = await response.json().catch(() => null);
    return response.ok ? { data, error: null } : { data: null, error: errorFrom(data, response.status) };
  }
  async list(path = '', options?: { limit?: number; offset?: number; sortBy?: { column: string; order: string }; search?: string }): Promise<Result<Array<{ name: string; id?: string; metadata?: Record<string, unknown> }>>> {
    const response = await fetch(`/api/storage/list/${encodeURIComponent(this.bucket)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, ...options }) });
    const data = await response.json().catch(() => null);
    return response.ok ? { data, error: null } : { data: null, error: errorFrom(data, response.status) };
  }
  async remove(paths: string[]): Promise<Result<unknown[]>> {
    const response = await fetch(`/api/storage/remove/${encodeURIComponent(this.bucket)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) });
    const data = await response.json().catch(() => null);
    return response.ok ? { data, error: null } : { data: null, error: errorFrom(data, response.status) };
  }
  getPublicUrl(path: string): { data: { publicUrl: string } } {
    return { data: { publicUrl: `/api/storage/file/${encodeURIComponent(this.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}` } };
  }
  async createSignedUrl(path: string, expiresIn: number): Promise<Result<{ signedUrl: string }>> {
    const response = await fetch(`/api/storage/sign/${encodeURIComponent(this.bucket)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [path], expiresIn }) });
    const data = await response.json().catch(() => null);
    return response.ok ? { data: data?.[0] ?? null, error: null } : { data: null, error: errorFrom(data, response.status) };
  }
  async createSignedUrls(paths: string[], expiresIn: number): Promise<Result<Array<{ path: string; signedUrl: string }>>> {
    const response = await fetch(`/api/storage/sign/${encodeURIComponent(this.bucket)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths, expiresIn }) });
    const data = await response.json().catch(() => null);
    return response.ok ? { data, error: null } : { data: null, error: errorFrom(data, response.status) };
  }
  async download(path: string): Promise<Result<Blob>> {
    const response = await fetch(this.getPublicUrl(path).data.publicUrl, { credentials: 'same-origin' });
    return response.ok ? { data: await response.blob(), error: null } : { data: null, error: errorFrom(await response.json().catch(() => null), response.status) };
  }
}

const live = new LiveClient();

export const platform = {
  auth: new AuthClient(),
  from<T = any>(table: string): DataQuery<T> { return new DataQuery<T>(encodeURIComponent(table)); },
  rpc<T = any>(fn: string, args: Record<string, unknown> = {}, options?: { head?: boolean; count?: string }): DataQuery<T> {
    const query = new DataQuery<T>(`rpc/${encodeURIComponent(fn)}`);
    if (options?.head) return query.select('*', options);
    return query.insert(args, options);
  },
  storage: { from(bucket: string) { return new StorageBucket(bucket); } },
  channel(topic: string) { return live.channel(topic); },
  removeChannel(channel: LiveChannel) { return live.remove(channel); },
  removeAllChannels() { return live.removeAll(); },
};

export type PlatformClient = typeof platform;

