/** Scriptable 的只读缓存接口。生命周期属于主进程，设置页关闭后仍可读取。 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fieldValues, formatField } from '../renderer/card-svg.js';
import { normalizeFieldOrder } from '../renderer/fields.js';
import { resolveAppearance, type AppearanceConfig } from './appearance.js';
import { cachedSnapshot, snapshotToCard } from './card.js';
import { usagePeriod } from './billing-estimate.js';
import { PluginStore, atomicWrite } from './store.js';

export const WIDGET_PORT = 19861;
interface Settings { enabled: boolean; port: number; tokenHash?: string; identityKey?: string; tokenCreatedAt?: number; }
interface DisplayConfig extends AppearanceConfig { platform?: string; theme?: 'light' | 'dark'; fields?: unknown; accounts?: Array<{consNo?: string; title?: string; showRegion?: boolean; enabled?: boolean}>; }
function read<T>(file: string, fallback: T): T {try {return JSON.parse(readFileSync(file, 'utf8'));} catch {return fallback;}}
const digest = (token: string) => createHash('sha256').update(token).digest();

export class WidgetSettings {
  readonly directory: string;
  constructor(readonly storagePath: string) {
    this.directory = join(storagePath, 'state-grid/widgets');
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
  }
  read(): Settings {
    const value = read<Partial<Settings>>(join(this.directory, 'settings.json'), {});
    return {...value, enabled: value.enabled === true, port: Number.isInteger(value.port) && value.port! >= 1024 && value.port! <= 65535 ? value.port! : WIDGET_PORT};
  }
  private write(value: Settings): void {atomicWrite(join(this.directory, 'settings.json'), JSON.stringify(value, null, 2) + '\n');}
  status() {
    const settings = this.read();
    const runtime = read<{pid?: number; port?: number; listening?: boolean; error?: string}>(join(this.directory, 'runtime.json'), {});
    let alive = false;
    if (runtime.pid) {try {process.kill(runtime.pid, 0); alive = true;} catch { /* stopped */ }}
    return {ok: true, enabled: settings.enabled, port: settings.port, hasToken: !!settings.tokenHash, tokenCreatedAt: settings.tokenCreatedAt || null,
      listening: settings.enabled && alive && runtime.listening === true && runtime.port === settings.port,
      error: settings.enabled && alive ? runtime.error || null : null};
  }
  configure(enabled: boolean, port: number) {
    if (typeof enabled !== 'boolean' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('请填写 1024～65535 之间的端口');
    this.write({...this.read(), enabled, port}); return this.status();
  }
  rotateToken() {
    const token = randomBytes(32).toString('base64url'); const current = this.read();
    this.write({...current, tokenHash: digest(token).toString('hex'), identityKey: current.identityKey || randomBytes(32).toString('hex'), tokenCreatedAt: Date.now()});
    return {...this.status(), token}; // 明文只在这次已认证的设置页请求中返回。
  }
  revokeToken() {const current = this.read(); delete current.tokenHash; delete current.tokenCreatedAt; this.write(current); return this.status();}
  authorized(header: string | undefined): boolean {
    const settings = this.read(); const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '');
    if (!settings.enabled || !match || !/^[a-f0-9]{64}$/.test(settings.tokenHash || '')) return false;
    return timingSafeEqual(digest(match[1]), Buffer.from(settings.tokenHash!, 'hex'));
  }
}

/** 字段逐项白名单输出，不返回原始快照、户号、姓名、详细地址或国网会话。 */
export function widgetPayload(storagePath: string, now = Date.now()) {
  const settings = new WidgetSettings(storagePath).read();
  const store = new PluginStore(storagePath);
  const config = read<{platforms?: DisplayConfig[]}>(join(storagePath, 'config.json'), {}).platforms?.find(p => p.platform === 'StateGrid') || {};
  const visibility = store.loadVisibility(), appearance = store.loadAppearance();
  const fields = normalizeFieldOrder(store.loadFields() || config.fields);
  const state = store.loadRuntimeStatus()?.state;
  const accounts = (store.loadAccountsCache()?.accounts || []).filter(account => {
    const configured = config.accounts?.find(a => a.consNo === account.consNo);
    return (visibility[account.consNo] ?? configured?.enabled ?? account.enabled) !== false;
  }).map(account => {
    const look = resolveAppearance(account.consNo, account.address, appearance[account.consNo], config);
    const snapshot = cachedSnapshot(account.data ?? account.snapshot);
    // 无真实快照时给出缺失值，不伪造演示数据。
    const card = snapshotToCard(snapshot || {updatedAt: 0, dailySeries: []} as any, {title: look.name, fields}, now);
    const metrics = fieldValues(card).map(field => ({key: field.key, label: field.label,
      value: typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : null,
      text: formatField(field), unit: field.unit, estimated: field.estimated === true, ...(field.note ? {note: field.note} : {}), ...(field.period ? {period: field.period} : {}), ...(field.through ? {through: field.through} : {})}));
    const updatedAt = snapshot?.updatedAt || null;
    const period = snapshot ? usagePeriod(snapshot, now) : null;
    const stale = !!period?.month && !period.current || !updatedAt || now - updatedAt > 26 * 3600000 || !!account.lastError || state === 'needs_verification' || state === 'error';
    return {id: createHmac('sha256', settings.identityKey || '').update(account.consNo).digest('hex').slice(0, 24),
      title: look.name, region: look.region || null, theme: config.theme === 'dark' ? 'dark' : 'light', updatedAt,
      stale, dataMonth: period?.month || null, status: !updatedAt ? '暂无用电数据' : stale ? '数据未更新 · 显示缓存' : '已同步', metrics};
  });
  return {schemaVersion: 1, generatedAt: now, refreshAfterSeconds: 3600, accounts};
}

export class WidgetServer {
  readonly settings: WidgetSettings;
  private server?: Server;
  private port?: number;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private retryAt = 0;
  private failures = new Map<string, {count: number; until: number}>();
  constructor(readonly storagePath: string, private readonly notify: (message: string) => void = () => {}) {
    this.settings = new WidgetSettings(storagePath);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 2000); this.timer.unref();
  }
  private runtime(listening: boolean, error?: string): void {
    atomicWrite(join(this.settings.directory, 'runtime.json'), JSON.stringify({pid: process.pid, port: this.port, listening, error}));
  }
  private close(): void {const previous = this.server; this.server = undefined; previous?.close(); previous?.closeAllConnections(); if (previous) this.runtime(false); this.port = undefined;}
  private reconcile(): void {
    try {
      const settings = this.settings.read();
      if (this.server && (!settings.enabled || settings.port !== this.port)) this.close();
      if (!this.server && this.port !== settings.port) this.retryAt = 0;
      if (this.server || !settings.enabled || Date.now() < this.retryAt || this.stopped) return;
      const server = createServer({maxHeaderSize: 8192}, (request, response) => {
        const send = (code: number, value: unknown) => {response.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); response.end(JSON.stringify(value));};
        const ip = request.socket.remoteAddress || '';
        const failed = this.failures.get(ip);
        if (failed && failed.until > Date.now() && failed.count >= 12) {send(429, {error: '请求过于频繁，请稍后重试'}); return;}
        if (!this.settings.authorized(request.headers.authorization)) {
          if (this.failures.size > 256) this.failures.clear();
          this.failures.set(ip, {count: failed && failed.until > Date.now() ? failed.count + 1 : 1, until: Date.now() + 60000});
          send(401, {error: '小组件访问令牌无效或接口已关闭'}); return;
        }
        if (request.headers.origin) {send(403, {error: '此接口仅供小组件读取'}); return;}
        if (request.method !== 'GET') {send(405, {error: '仅支持只读请求'}); return;}
        if (request.url !== '/v1/widget') {send(404, {error: '接口不存在'}); return;}
        try {send(200, widgetPayload(this.storagePath));} catch {send(503, {error: '缓存暂不可用，请稍后重试'});}
      });
      server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
      this.server = server; this.port = settings.port;
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (this.server !== server) return;
        this.server = undefined; this.retryAt = Date.now() + 30000;
        const message = error.code === 'EADDRINUSE' ? '小组件端口已被占用，请在设置页更换端口' : '小组件接口启动失败，请检查监听地址和端口';
        this.runtime(false, message); this.notify(message);
      });
      server.listen(settings.port, '0.0.0.0', () => {if (this.server === server) this.runtime(true);});
      server.unref();
    } catch {this.retryAt = Date.now() + 30000; this.notify('小组件设置暂不可读，稍后重试');}
  }
  stop(): void {this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.close(); this.failures.clear();}
}
