import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { updateEndpoint, safeUpdateError, updateErrorCode, redactUpdateText } from './update-config.js';

const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const userError = (message) => Object.assign(new Error(message), { userMessage: message });

const parseVersion = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > 96) return null;
  const match = text.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/);
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) return null;
  return { version: match[0].replace(/^v/, ''), core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
};

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw userError('更新服务返回了无法识别的版本号，可选择手动下载');
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined || b.pre[index] === undefined) return a.pre[index] === b.pre[index] ? 0 : a.pre[index] === undefined ? -1 : 1;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumeric = /^\d+$/.test(a.pre[index]);
    const bNumeric = /^\d+$/.test(b.pre[index]);
    if (aNumeric && bNumeric) {
      const av = BigInt(a.pre[index]);
      const bv = BigInt(b.pre[index]);
      if (av !== bv) return av > bv ? 1 : -1;
    } else if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    else return a.pre[index] > b.pre[index] ? 1 : -1;
  }
  return 0;
}

const unwrapRelease = (payload) => {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (root && typeof root === 'object' && Object.hasOwn(root, 'latest')) return root.latest;
  return root?.release ?? root;
};

export function normalizeRelease(payload) {
  let raw = unwrapRelease(payload);
  if (typeof raw === 'string') raw = { version: raw };
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseVersion(raw.version ?? raw.latest_version ?? raw.tag_name);
  if (!parsed) return null;
  const file = Array.isArray(raw.files) ? raw.files.find((entry) => /setup|installer/i.test(entry.name ?? entry.filename ?? ''))
    ?? raw.files.find((entry) => entry.platform === 'windows') : raw.file;
  const checksum = raw.sha256 ?? raw.checksum_sha256 ?? file?.sha256
    ?? (typeof raw.checksum === 'object' ? raw.checksum?.sha256 : /^[a-f\d]{64}$/i.test(raw.checksum ?? '') ? raw.checksum : null);
  if (checksum && !/^(?:sha256:)?[a-f\d]{64}$/i.test(String(checksum))) throw userError('更新包校验信息格式不正确，请手动下载或联系作者');
  const size = Number(raw.file_size ?? raw.size ?? raw.size_bytes ?? file?.size ?? file?.file_size);
  const notes = raw.release_notes ?? raw.changelog ?? raw.notes ?? raw.description ?? '';
  return {
    version: parsed.version,
    notes: (Array.isArray(notes) ? notes.join('\n') : String(notes)).slice(0, 16000),
    publishedAt: String(raw.published_at ?? raw.publishedAt ?? raw.created_at ?? ''),
    size: Number.isFinite(size) && size > 0 ? size : null,
    sha256: checksum ? String(checksum).replace(/^sha256:/i, '').toLowerCase() : null
  };
}

export class UpdateService extends EventEmitter {
  constructor({ version, isPackaged, portable = false, cacheDirectory, fetcher, openExternal, quit }) {
    super();
    this.fetcher = fetcher;
    this.openExternal = openExternal;
    this.quit = quit;
    this.cacheDirectory = cacheDirectory;
    this.closed = false;
    this.checkPromise = null;
    this.downloadPromise = null;
    this.checkAbort = null;
    this.checkCancelled = false;
    this.downloadAbort = null;
    this.startupTimer = null;
    this.installerPath = null;
    this.installerRelease = null;
    this.state = {
      currentVersion: version, latest: null, status: 'idle', message: '可随时检查新版本',
      mode: !isPackaged ? 'development' : portable ? 'portable' : 'installed',
      canInstall: process.platform === 'win32' && isPackaged && !portable,
      updateAvailable: false, revision: 0, arch: process.arch, errorCode: null,
      downloadedBytes: 0, totalBytes: null, percent: null, checkedAt: null,
      source: 'download.carl.top'
    };
    if (isPackaged) void this.cleanupStaleDownloads().catch(() => {});
  }

  async cleanupStaleDownloads() {
    const root = path.resolve(this.cacheDirectory);
    if (path.basename(root) !== 'MonitorTool-updates') return;
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const directory of directories.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^download-[a-z\d]{6}$/i.test(entry.name)).slice(0, 100)) {
      if (this.closed) return;
      const child = path.resolve(root, directory.name);
      if (path.dirname(child) !== root) continue;
      const files = await readdir(child, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !/^MonitorTool-[\da-z.+-]+-Setup-(x64|ia32|arm64)\.exe(\.part)?$/i.test(file.name)) continue;
        const target = path.resolve(child, file.name);
        if (path.dirname(target) !== child) continue;
        const details = await stat(target).catch(() => null);
        const maximumAge = file.name.endsWith('.part') ? 24 * 3_600_000 : 7 * 24 * 3_600_000;
        if (details && Date.now() - details.mtimeMs > maximumAge) await unlink(target).catch(() => {});
      }
      // Non-recursive: keep a directory if it contains anything we do not own.
      await rmdir(child).catch(() => {});
    }
  }

  getState() {
    // Only display information crosses IPC; checksums, tokens and disk paths do not.
    const { sha256: _checksum, ...latest } = this.state.latest ?? {};
    return { ...this.state, latest: this.state.latest ? latest : null };
  }

  update(patch) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.emit('change', this.getState());
  }

  reportFailure(stage, error) {
    if (this.closed) return;
    this.emit('diagnostic', {
      at: new Date().toISOString(), stage, code: updateErrorCode(error),
      message: redactUpdateText(error?.message).slice(0, 1000),
      stack: redactUpdateText(error?.stack).split('\n').slice(0, 5).join('\n')
    });
  }

  scheduleStartupCheck(enabled) {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (!enabled || this.state.mode === 'development' || this.closed) return;
    this.startupTimer = setTimeout(() => { this.startupTimer = null; void this.check(); }, 8000);
    this.startupTimer.unref?.();
  }

  disablePendingStartupCheck() {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  async request(url, signal) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw userError('更新服务返回了不安全的下载地址');
    return this.fetcher(target.href, { signal, redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer' });
  }

  async json(action, signal) {
    const response = await this.request(updateEndpoint(action, this.state.currentVersion), signal);
    if (response.status === 404 && action === 'latest') { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw userError(`更新服务请求失败（${response.status}），请稍后重试`); }
    const chunks = [];
    let size = 0;
    if (!response.body) throw userError('更新服务返回为空，请稍后重试');
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > 512 * 1024) throw userError('更新服务返回的数据过大');
      chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw userError('更新服务返回格式不正确，请稍后重试'); }
    if (payload?.success === false || payload?.error) throw userError('更新服务返回错误，请联系作者检查发布配置');
    return payload;
  }

  check() {
    if (this.checkPromise) return this.checkPromise;
    if (this.closed || ['downloading', 'verifying', 'installing'].includes(this.state.status)) return Promise.resolve(this.getState());
    this.disablePendingStartupCheck();
    const pending = this.checkNow().finally(() => { if (this.checkPromise === pending) this.checkPromise = null; });
    this.checkPromise = pending;
    return pending;
  }

  async checkNow() {
    this.checkAbort = new AbortController();
    this.checkCancelled = false;
    const timer = setTimeout(() => this.checkAbort?.abort(), 20000);
    this.update({ status: 'checking', errorCode: null, message: '正在检查新版本…' });
    try {
      const body = await this.json('check', this.checkAbort.signal);
      const root = body?.data ?? body;
      const serverAllowsUpdate = root?.update !== false && root?.has_update !== false;
      let latest = normalizeRelease(body);
      if (!latest && !(root?.update === false && root?.latest === null)) {
        const latestBody = await this.json('latest', this.checkAbort.signal);
        latest = normalizeRelease(latestBody);
        if (!latest && (latestBody !== null || root?.update === true)) throw userError('更新服务缺少有效版本信息，请联系作者检查发布配置');
      }
      if (latest && compareVersions(latest.version, this.state.currentVersion) > 0) {
        try {
          const detailed = normalizeRelease(await this.json('latest', this.checkAbort.signal));
          if (detailed && compareVersions(detailed.version, latest.version) >= 0) latest = detailed;
        } catch (error) { if (this.checkAbort.signal.aborted || error.userMessage?.includes('校验信息')) throw error; }
      }
      if (this.closed) return this.getState();
      if (!latest) this.update({ latest: null, updateAvailable: false, status: 'unpublished', checkedAt: Date.now(), message: '更新服务暂未发布 Windows 版本' });
      else if (compareVersions(latest.version, this.state.currentVersion) > 0 && serverAllowsUpdate) {
        this.update({ latest, updateAvailable: true, status: 'available', checkedAt: Date.now(), message: `发现新版本 v${latest.version}` });
        this.emit('available', this.getState());
      } else {
        const comparison = compareVersions(latest.version, this.state.currentVersion);
        this.update({ latest, updateAvailable: false, status: 'current', checkedAt: Date.now(), message: comparison < 0 ? '当前版本高于更新通道版本，无需更新' : comparison > 0 ? '更新通道暂未向当前版本推送更新' : '当前已是最新版本' });
      }
    } catch (error) {
      if (!this.checkCancelled) this.reportFailure('check', error);
      this.update({ status: this.checkCancelled ? 'cancelled' : 'error', errorCode: this.checkCancelled ? null : updateErrorCode(error), checkedAt: Date.now(), message: this.checkCancelled ? '检查已取消，可稍后重试' : safeUpdateError(error) });
    } finally {
      clearTimeout(timer);
      this.checkAbort = null;
    }
    return this.getState();
  }

  downloadAndInstall() {
    if (this.downloadPromise) return this.downloadPromise;
    const pending = this.downloadNow().finally(() => { if (this.downloadPromise === pending) this.downloadPromise = null; });
    this.downloadPromise = pending;
    return pending;
  }

  async downloadNow() {
    if (this.closed || !this.state.canInstall) {
      this.update({ status: 'error', message: this.state.mode === 'portable' ? '便携版请手动下载替换；安装版支持内置安装' : '开发环境不执行安装，请使用安装版或手动下载' });
      return this.getState();
    }
    const release = this.state.latest;
    if (!this.state.updateAvailable || !release || compareVersions(release.version, this.state.currentVersion) <= 0) return this.getState();
    this.downloadAbort = new AbortController();
    const signal = this.downloadAbort.signal;
    let partialPath = null;
    let completedPath = null;
    let idleTimer;
    let timedOut = false;
    const armTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; this.downloadAbort?.abort(); }, 60000);
    };
    try {
      if (this.installerPath && this.installerRelease === release.version) {
        let verified = false;
        try { await this.verifyInstaller(this.installerPath, release, signal); verified = true; }
        catch (error) {
          if (signal.aborted || this.closed) throw error;
          await unlink(this.installerPath).catch(() => {});
          this.installerPath = null;
          this.installerRelease = null;
        }
        if (verified) { await this.install(this.installerPath); return this.getState(); }
      }
      this.update({ status: 'downloading', errorCode: null, message: '正在下载安装包…', downloadedBytes: 0, totalBytes: release.size, percent: 0 });
      armTimeout();
      const response = await this.request(updateEndpoint('download'), signal);
      if (!response.ok || !response.body) throw userError('下载安装包失败，请重试或选择手动下载');
      if (/json|text\/html/i.test(response.headers.get('content-type') ?? '')) throw userError('下载接口未返回安装包，请联系作者检查发布配置');
      const length = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length'));
      const total = release.size || (Number.isFinite(length) && length > 0 ? length : null);
      if (total && total > MAX_DOWNLOAD_BYTES) throw userError('更新包超过大小限制，请选择手动下载');
      await mkdir(this.cacheDirectory, { recursive: true });
      const directory = await mkdtemp(path.join(this.cacheDirectory, 'download-'));
      completedPath = path.join(directory, `MonitorTool-${release.version}-Setup-${process.arch}.exe`);
      partialPath = completedPath + '.part';
      let received = 0;
      let reportedAt = 0;
      const progress = new Transform({ transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        armTimeout();
        if (received > MAX_DOWNLOAD_BYTES) { callback(userError('更新包超过大小限制，请选择手动下载')); return; }
        if (Date.now() - reportedAt >= 200) {
          reportedAt = Date.now();
          this.update({ downloadedBytes: received, totalBytes: total, percent: total ? Math.min(100, received / total * 100) : null });
        }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partialPath, { flags: 'wx' }), { signal });
      clearTimeout(idleTimer);
      if (total && received !== total) throw userError('安装包大小不匹配，已停止安装，请重新下载');
      this.update({ status: 'verifying', message: '正在检查安装包…', downloadedBytes: received, totalBytes: total ?? received, percent: 100 });
      await this.verifyInstaller(partialPath, release, signal);
      if (signal.aborted || this.closed) throw new DOMException('Cancelled', 'AbortError');
      await rename(partialPath, completedPath);
      partialPath = null;
      this.installerPath = completedPath;
      this.installerRelease = release.version;
      await this.install(completedPath);
    } catch (error) {
      if (partialPath) await unlink(partialPath).catch(() => {});
      if (completedPath && this.installerPath !== completedPath) await unlink(completedPath).catch(() => {});
      if (!signal.aborted || timedOut) this.reportFailure('download', error);
      this.update({ status: signal.aborted && !timedOut ? 'cancelled' : 'error', errorCode: signal.aborted && !timedOut ? null : updateErrorCode(error), message: timedOut ? '下载长时间没有响应，请重试或选择手动下载' : signal.aborted ? '下载已取消，可稍后重试' : safeUpdateError(error) });
    } finally {
      clearTimeout(idleTimer);
      this.downloadAbort?.abort();
      this.downloadAbort = null;
    }
    return this.getState();
  }

  async verifyInstaller(filePath, release, signal) {
    const fileStat = await stat(filePath);
    if (fileStat.size < 1024 * 1024 || fileStat.size > MAX_DOWNLOAD_BYTES || release.size && release.size !== fileStat.size) throw userError('安装包大小异常，已停止安装');
    const file = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(64);
      await file.read(header, 0, header.length, 0);
      if (header.toString('ascii', 0, 2) !== 'MZ') throw userError('下载的文件不是有效的 Windows 安装程序');
      const peOffset = header.readUInt32LE(60);
      if (peOffset < 64 || peOffset > fileStat.size - 4) throw userError('安装程序格式异常，已停止安装');
      const signature = Buffer.alloc(4);
      await file.read(signature, 0, 4, peOffset);
      if (!signature.equals(Buffer.from([80, 69, 0, 0]))) throw userError('安装程序格式异常，已停止安装');
    } finally { await file.close(); }
    if (release.sha256) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
      const actual = hash.digest();
      if (!timingSafeEqual(actual, Buffer.from(release.sha256, 'hex'))) throw userError('安装包 SHA-256 校验未通过，已停止安装，请联系作者');
    }
  }

  async install(filePath) {
    if (this.closed || this.downloadAbort?.signal.aborted) return;
    await new Promise((resolve, reject) => {
      const child = spawn(filePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', () => reject(userError('Windows 未能启动安装器，请选择手动下载并安装')));
      child.once('spawn', () => {
        child.unref();
        this.update({ status: 'installing', message: '安装器已启动，正在退出 Monitor Tool…' });
        setTimeout(() => this.quit(), 250);
        resolve();
      });
    });
  }

  cancelDownload() { this.downloadAbort?.abort(); }

  cancelCheck() { if (this.checkAbort) { this.checkCancelled = true; this.checkAbort.abort(); } }

  async manualDownload() {
    try { await this.openExternal(updateEndpoint('download')); }
    catch (error) { this.update({ status: 'error', message: error.userMessage || '未能打开浏览器，请稍后重试' }); }
    return this.getState();
  }

  stop() {
    this.closed = true;
    this.disablePendingStartupCheck();
    this.checkAbort?.abort();
    this.downloadAbort?.abort();
  }
}
