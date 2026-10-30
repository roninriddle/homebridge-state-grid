/** GitHub 正式发布检查与用户主动安装；不读取或发送国网凭据。 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import * as tar from 'tar';
import { atomicWrite } from './store.js';

const run = promisify(execFile);
export const UPDATE_REPOSITORY = 'roninriddle/homebridge-state-grid';
export const CHECK_INTERVAL = 12 * 3600_000;
const RETRY_INTERVAL = 3600_000;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_EXTRACTED = 128 * 1024 * 1024;
const PACKAGE_NAME = 'homebridge-state-grid';
const API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
interface Release {
  id: number; version: string; tag: string; url: string; notes: string; publishedAt: string;
  asset?: {name: string; url: string; digest: string; size: number};
}
interface CheckCache {
  attemptedAt?: number; checkedAt?: number; nextCheckAt?: number; etag?: string;
  release?: Release | null; error?: string;
}
interface Operation { state: 'installing' | 'installed' | 'failed'; version: string; previousVersion: string; updatedAt: number; backup?: string; error?: string; }
interface Options {
  fetch?: typeof fetch; now?: () => number;
  prepare?: (candidate: string) => Promise<void>;
}
function read<T>(file: string, fallback: T): T { try {return JSON.parse(readFileSync(file, 'utf8'));} catch {return fallback;} }
function write(file: string, value: unknown): void { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }

export function releaseFromApi(raw: any): Release {
  const version = typeof raw?.tag_name === 'string' ? semver.valid(raw.tag_name.replace(/^v/, '')) : null;
  if (!version || semver.prerelease(version) || raw.draft || raw.prerelease || (!Number.isSafeInteger(raw.id) || raw.id <= 0)) throw new Error('发布版本信息无效');
  const tag = raw.tag_name;
  const url = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${tag}`;
  const name = `${PACKAGE_NAME}-${version}.tgz`;
  const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`;
  const file = raw.assets?.find((a: any) => a.name === name && a.state === 'uploaded' && a.browser_download_url === expected && /^sha256:[a-f0-9]{64}$/.test(a.digest) && a.size > 0 && a.size <= MAX_ARCHIVE);
  return {id: raw.id, version, tag, url, notes: String(raw.body || '').slice(0, 4000), publishedAt: String(raw.published_at || ''),
    ...(file ? {asset: {name, url: expected, digest: file.digest.slice(7), size: file.size}} : {})};
}

async function bytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('下载内容为空');
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > limit) throw new Error('下载内容超过大小限制');
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

export async function unpackRelease(archive: string, directory: string): Promise<string> {
  let total = 0; let count = 0; let invalid = false;
  await tar.t({file: archive, strict: true, onReadEntry(entry) {
    const name = entry.path;
    const valid = (name === 'package/' && entry.type === 'Directory') || name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..') && !posix.isAbsolute(name) &&
      ['File', 'Directory'].includes(entry.type) && /^package\/(dist(?:\/|$)|homebridge-ui(?:\/|$)|(?:package(?:-lock)?|npm-shrinkwrap)\.json$|config\.schema\.json$|README\.md$|CHANGELOG\.md$|LICENSE$)/.test(name);
    total += entry.size || 0; count++;
    if (!valid || total > MAX_EXTRACTED || count > 2000) invalid = true;
  }});
  if (invalid || !count) throw new Error('更新包结构或大小不符合要求');
  await tar.x({file: archive, cwd: directory, strict: true, preservePaths: false, preserveOwner: false, noChmod: true, noMtime: true});
  const candidate = join(directory, 'package');
  if ((!existsSync(join(candidate, 'npm-shrinkwrap.json')) && !existsSync(join(candidate, 'package-lock.json'))) || !existsSync(join(candidate, 'dist/index.js'))) throw new Error('更新包缺少编译产物或依赖锁文件');
  return candidate;
}

export class PluginUpdates {
  readonly directory: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly initialVersion: string;
  private inFlight?: Promise<ReturnType<PluginUpdates['status']>>;
  private startupTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private notifiedVersion?: string;
  private backgroundRunning = false;
  constructor(readonly storagePath: string, readonly packageRoot = resolve(__dirname, '../..'), private readonly options: Options = {}) {
    this.directory = join(storagePath, 'state-grid', 'updates'); mkdirSync(this.directory, {recursive: true, mode: 0o700});
    this.request = options.fetch || fetch; this.now = options.now || Date.now;
    this.initialVersion = read(join(packageRoot, 'package.json'), {version: '0.0.0'}).version;
  }
  installedVersion(): string { return read(join(this.packageRoot, 'package.json'), {version: this.initialVersion}).version; }
  status() {
    const cache = read<CheckCache>(join(this.directory, 'check.json'), {});
    const operation = read<Operation | null>(join(this.directory, 'operation.json'), null);
    const installed = this.installedVersion();
    const running = read<{pluginVersion?: string}>(join(this.storagePath, 'state-grid/cache/status.json'), {}).pluginVersion || null;
    const enabled = read(join(this.directory, 'settings.json'), {enabled: true}).enabled !== false;
    const available = !!cache.release && !!semver.valid(installed) && semver.gt(cache.release.version, installed);
    return {ok: true, enabled, installedVersion: installed, runningVersion: running, checkedAt: cache.checkedAt || null,
      nextCheckAt: cache.nextCheckAt || null, latestVersion: cache.release?.version || null,
      releaseUrl: cache.release?.url || `https://github.com/${UPDATE_REPOSITORY}/releases`, notes: cache.release?.notes || '',
      updateAvailable: available, canInstall: available && !!cache.release?.asset,
      restartRequired: !!running && installed !== running, error: cache.error || null, operation};
  }
  setEnabled(enabled: boolean) { if (typeof enabled !== 'boolean') throw new Error('请选择是否自动检查更新'); write(join(this.directory, 'settings.json'), {enabled: enabled !== false}); return this.status(); }
  start(notify?: (message: string) => void): void {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;
    const check = () => {
      void this.check().then(status => {
        if (!status.error && status.updateAvailable && status.latestVersion !== this.notifiedVersion) {
          this.notifiedVersion = status.latestVersion || undefined;
          notify?.(`插件有新版本 ${status.latestVersion}，可在设置页“插件更新”查看。`);
        }
      }).catch(() => {}).finally(() => {
        if (!this.backgroundRunning) return;
        const status = this.status();
        const wait = status.enabled ? Math.max(30_000, Math.min(RETRY_INTERVAL, (status.nextCheckAt || this.now() + CHECK_INTERVAL) - this.now())) : RETRY_INTERVAL;
        this.timer = setTimeout(check, wait); this.timer.unref?.();
      });
    };
    this.startupTimer = setTimeout(check, 30_000); this.startupTimer.unref?.();
  }
  stop(): void {this.backgroundRunning = false; clearTimeout(this.startupTimer); clearTimeout(this.timer); this.startupTimer = undefined; this.timer = undefined;}
  check(force = false): Promise<ReturnType<PluginUpdates['status']>> {
    if (this.inFlight) return this.inFlight;
    const cache = read<CheckCache>(join(this.directory, 'check.json'), {});
    const now = this.now();
    if ((!force && (!this.status().enabled || (cache.nextCheckAt || 0) > now)) || (cache.attemptedAt !== undefined && now - cache.attemptedAt < 30_000)) return Promise.resolve(this.status());
    this.inFlight = this.fetchRelease(cache).finally(() => {this.inFlight = undefined;});
    return this.inFlight;
  }
  private async fetchRelease(cache: CheckCache) {
    const now = this.now(); const current: CheckCache = {...cache, attemptedAt: now, nextCheckAt: now + RETRY_INTERVAL};
    write(join(this.directory, 'check.json'), {...current, nextCheckAt: now + RETRY_INTERVAL});
    try {
      const headers: Record<string, string> = {'Accept': 'application/vnd.github+json', 'User-Agent': `${PACKAGE_NAME}/${this.installedVersion()}`, 'X-GitHub-Api-Version': '2022-11-28'};
      if (cache.etag) headers['If-None-Match'] = cache.etag;
      const response = await this.request(API_URL, {headers, signal: AbortSignal.timeout(15_000), redirect: 'error'});
      if (response.status === 404) current.release = null;
      else if (response.status === 304) { if (cache.release === undefined) throw new Error('没有可复用的版本缓存'); }
      else if (!response.ok) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        if ([403, 429].includes(response.status) && Number.isFinite(reset)) current.nextCheckAt = Math.min(now + 24 * 3600_000, Math.max(now + RETRY_INTERVAL, reset));
        throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 检查限流，稍后自动重试' : `检查更新失败（HTTP ${response.status}）`);
      } else current.release = releaseFromApi(JSON.parse((await bytes(response, 1024 * 1024)).toString()));
      current.checkedAt = now; current.nextCheckAt = now + CHECK_INTERVAL; current.error = undefined;
      current.etag = response.headers.get('etag') || cache.etag;
    } catch (error) {current.error = (error as Error).name === 'TimeoutError' ? '检查更新超时，稍后自动重试' : (error as Error).message; current.nextCheckAt ||= now + RETRY_INTERVAL;}
    write(join(this.directory, 'check.json'), current); return this.status();
  }
  private acquireLock(): () => void {
    const lock = join(this.directory, 'install.lock');
    try {mkdirSync(lock);} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = read<{pid?: number}>(join(lock, 'owner.json'), {});
      let alive = false; if (owner.pid) {try {process.kill(owner.pid, 0); alive = true;} catch (e) {alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';}}
      if (alive) throw new Error('插件更新正在进行，请勿重复安装');
      rmSync(lock, {recursive: true, force: true}); mkdirSync(lock);
    }
    write(join(lock, 'owner.json'), {pid: process.pid});
    return () => rmSync(lock, {recursive: true, force: true});
  }
  private async download(release: Release): Promise<Buffer> {
    let url = release.asset!.url;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('更新下载地址不可信');
      const response = await this.request(url, {redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: {'User-Agent': PACKAGE_NAME}});
      if ([301, 302, 303, 307, 308].includes(response.status)) {const next = response.headers.get('location'); await response.body?.cancel(); if (!next) break; url = new URL(next, url).href; continue;}
      if (!response.ok) throw new Error(`下载更新失败（HTTP ${response.status}）`);
      const archive = await bytes(response, MAX_ARCHIVE);
      if (archive.length !== release.asset!.size || createHash('sha256').update(archive).digest('hex') !== release.asset!.digest) throw new Error('更新包大小或 SHA-256 校验失败');
      return archive;
    }
    throw new Error('更新下载重定向过多');
  }
  private async prepare(candidate: string): Promise<void> {
    if (this.options.prepare) return this.options.prepare(candidate);
    const npm = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(npm)) throw new Error('未找到当前 Node 对应的 npm，请使用 Homebridge 插件管理器安装');
    const env = {...process.env, PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '')};
    try { await run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--fetch-timeout=30000', '--fetch-retries=1', '--cache', join(this.directory, 'npm-cache')], {cwd: candidate, env, timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true}); }
    catch { throw new Error('更新依赖安装失败，正式插件未更改'); }
    const script = `require(${JSON.stringify(candidate)});const {renderPng,fallbackCardSvg,pngToJpeg}=require(${JSON.stringify(join(candidate, 'dist/renderer/image-renderer.js'))});const png=renderPng(fallbackCardSvg(320,180,'State Grid'));pngToJpeg(png).then(jpeg=>{if(jpeg[0]!==255||jpeg[1]!==216)process.exit(1)}).catch(()=>process.exit(1));`;
    try { await run(process.execPath, ['-e', script], {env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true}); }
    catch { throw new Error('更新包未通过原生渲染和 JPEG 检查，正式插件未更改'); }
  }
  async install(expectedVersion: string) {
    const unlock = this.acquireLock(); let workspace: string | undefined; let backup: string | undefined; let activated = false;
    const previousVersion = this.installedVersion();
    try {
      const status = await this.check(true);
      const release = read<CheckCache>(join(this.directory, 'check.json'), {}).release;
      if (status.error) throw new Error(status.error);
      if (!release?.asset || release.version !== expectedVersion || !semver.valid(previousVersion) || !semver.gt(release.version, previousVersion)) throw new Error('可安装版本已变化，请重新检查更新');
      if (process.platform === 'win32') throw new Error('Windows 请在 Homebridge 插件管理器中安装更新');
      if (existsSync(join(this.packageRoot, '.git')) || lstatSync(this.packageRoot).isSymbolicLink() || realpathSync(this.packageRoot) !== resolve(this.packageRoot)) throw new Error('开发目录或链接安装请使用原安装方式升级');
      write(join(this.directory, 'operation.json'), {state: 'installing', version: release.version, previousVersion, updatedAt: this.now()});
      const archive = await this.download(release);
      workspace = mkdtempSync(join(dirname(this.packageRoot), '.state-grid-update-'));
      const archiveFile = join(workspace, 'release.tgz'); atomicWrite(archiveFile, archive);
      const candidate = await unpackRelease(archiveFile, workspace);
      const pkg = read<any>(join(candidate, 'package.json'), {});
      if (pkg.name !== PACKAGE_NAME || pkg.version !== release.version || pkg.main !== 'dist/index.js' || pkg.scripts?.install || pkg.scripts?.preinstall || pkg.scripts?.postinstall) throw new Error('更新包元数据不符合要求');
      if (!pkg.engines?.node || !semver.satisfies(process.versions.node, pkg.engines.node)) throw new Error('当前 Node.js 版本不满足更新要求');
      const hb = read<any>(join(dirname(this.packageRoot), 'homebridge/package.json'), {});
      if (!hb.version || !pkg.engines?.homebridge || !semver.satisfies(hb.version, pkg.engines.homebridge)) throw new Error('当前 Homebridge 版本不满足更新要求');
      await this.prepare(candidate);
      if (this.installedVersion() !== previousVersion) throw new Error('插件已被其他安装程序更新，请重新检查');
      backup = join(dirname(this.packageRoot), `.state-grid-backup-${randomUUID()}`);
      renameSync(this.packageRoot, backup);
      try {renameSync(candidate, this.packageRoot); activated = true;} catch (error) {renameSync(backup, this.packageRoot); backup = undefined; throw error;}
      write(join(this.directory, 'operation.json'), {state: 'installed', version: release.version, previousVersion, backup, updatedAt: this.now()});
      return {...this.status(), restartRequired: true};
    } catch (error) {
      // 安装器不打印 npm 输出或访问令牌，只返回可读的失败信息；激活前失败不会触碰正式插件。
      const message = (error as NodeJS.ErrnoException).code === 'EACCES' ? '插件目录不可写，请使用 Homebridge 插件管理器安装' : (error as Error).message;
      if (!activated) write(join(this.directory, 'operation.json'), {state: 'failed', version: expectedVersion, previousVersion, error: message.slice(0, 500), updatedAt: this.now()});
      throw new Error(activated ? '新版本已安装，请重启国网子网桥并重新打开设置页' : message);
    } finally {if (workspace) rmSync(workspace, {recursive: true, force: true}); unlock();}
  }
}
