import { nativeTheme } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chooseTaskbarGap, retainTaskbarGeometry } from './taskbar-layout.js';
import { taskbarContent } from './taskbar-content.js';

export class TaskbarMonitor {
  constructor({ probe, snapshot }) {
    Object.assign(this, { probe, snapshot });
    this.width = 900; this.height = 40;
    this.geometry = null; this.lastGoodGeometry = null;
    this.child = null; this.host = null;
    this.retryTimer = null; this.hostRetryTimer = null;
    this.watchdog = null; this.recoveryTimeout = null;
    this.lastContent = ''; this.lastPlacement = '';
    nativeTheme.on('updated', () => this.renderContent());
  }
  update(config) {
    this.config = config;
    if (process.platform !== 'win32' || !config.taskbar.visible) { this.stop(); return; }
    if (!this.host) this.startHost();
    if (!this.child) this.startProbe();
    this.renderContent(); this.place();
  }
  write(command) {
    if (this.host?.stdin.writable) this.host.stdin.write(JSON.stringify(command) + '\n', () => {});
  }
  startHost() {
    if (this.host || !this.config?.taskbar.visible) return;
    const host = spawn(this.probe, ['--host', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.host = host; this.lastContent = ''; this.lastPlacement = '';
    host.stdin.on('error', () => {});
    host.stderr.on('data', chunk => console.warn('Taskbar native host:', String(chunk).slice(0, 600)));
    host.on('error', () => {});
    host.on('close', () => {
      if (this.host !== host) return;
      this.host = null;
      if (this.config?.taskbar.visible) this.hostRetryTimer = setTimeout(() => { this.hostRetryTimer = null; this.startHost(); }, 2000);
    });
    createInterface({ input: host.stdout }).on('line', line => {
      if (this.host !== host) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.kind === 'size' && Number.isFinite(message.width) && message.width >= 1) {
        this.width = Math.min(7200, message.width);
        if (Number.isFinite(message.height)) this.height = message.height;
        this.place();
      } else if (message.kind === 'ready') {
        this.lastContent = ''; this.lastPlacement = '';
        this.renderContent(); this.place();
      }
    });
  }
  startProbe() {
    if (this.child || !this.config?.taskbar.visible) return;
    // A blocked read-only scan can restart without destroying the native host.
    const child = spawn(this.probe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let lastResponse = Date.now();
    this.watchdog = setInterval(() => {
      if (this.child === child && Date.now() - lastResponse > 12000) child.kill();
    }, 3000);
    this.watchdog.unref();
    child.on('error', () => {});
    child.on('close', () => {
      if (this.child !== child) return;
      clearInterval(this.watchdog); this.watchdog = null; this.child = null;
      if (!this.recoveryTimeout) this.recoveryTimeout = setTimeout(() => {
        this.recoveryTimeout = null; this.geometry = null; this.place();
      }, 8000);
      if (this.config?.taskbar.visible) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.startProbe(); }, 2000);
    });
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message !== null && (!message.shell || !['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(message[key])) || !Array.isArray(message.blocked))) return;
      lastResponse = Date.now(); clearTimeout(this.recoveryTimeout); this.recoveryTimeout = null;
      if (message?.controlsAvailable && message.blocked?.length) this.lastGoodGeometry = message;
      this.geometry = retainTaskbarGeometry(this.lastGoodGeometry, message); this.place();
      if (message?.restartProbe) child.kill();
    });
  }
  send(channel, data) {
    if (channel === 'settings:changed') this.config = data;
    if (channel === 'monitor:update') this.latestSnapshot = data;
    this.renderContent();
  }
  renderContent() {
    if (!this.host || !this.config) return;
    const content = taskbarContent(this.config, this.latestSnapshot ?? this.snapshot?.(), nativeTheme.shouldUseDarkColors);
    const serialized = JSON.stringify(content);
    if (serialized !== this.lastContent) { this.lastContent = serialized; this.write(content); }
  }
  place() {
    if (!this.host) return;
    const g = this.geometry;
    let command = { kind: 'hide' };
    if (this.config?.taskbar.visible && g?.blocked?.length && g.bottom - g.top >= 20) {
      const gap = chooseTaskbarGap(g.left, g.right, g.blocked, this.width, this.config.taskbar.position);
      if (gap) {
        const height = Math.min(this.height, g.bottom - g.top);
        command = { kind: 'place', shell: g.shell, x: Math.round(gap.x), y: Math.round(g.top + (g.bottom - g.top - height) / 2), width: Math.floor(gap.width), height: Math.floor(height) };
      }
    }
    const serialized = JSON.stringify(command);
    if (serialized !== this.lastPlacement) { this.lastPlacement = serialized; this.write(command); }
  }
  stop() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearTimeout(this.hostRetryTimer); this.hostRetryTimer = null;
    clearTimeout(this.recoveryTimeout); this.recoveryTimeout = null;
    clearInterval(this.watchdog); this.watchdog = null;
    const child = this.child, host = this.host; this.child = null; this.host = null;
    child?.kill(); host?.kill();
    this.geometry = null; this.lastGoodGeometry = null;
    this.lastContent = ''; this.lastPlacement = '';
  }
}
