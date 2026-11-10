import { BrowserWindow, screen } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chooseTaskbarGap, retainTaskbarGeometry } from './taskbar-layout.js';

export class TaskbarMonitor {
  constructor({ preload, html, probe, snapshot }) {
    Object.assign(this, { preload, html, probe, snapshot });
    this.width = 900;
    this.geometry = null;
    this.lastGoodGeometry = null;
    this.win = null;
    this.child = null;
    this.retryTimer = null;
    this.taskbarRefreshAt = 0;
    this.watchdog = null;
  }
  update(config) {
    this.config = config;
    if (process.platform !== 'win32' || !config.taskbar.visible) { this.stop(); return; }
    if (!this.win || this.win.isDestroyed()) this.create();
    this.send('settings:changed', config);
    this.place();
  }
  create() {
    const win = new BrowserWindow({ width: 900, height: 40, show: false, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000', webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.on('close', event => { if (this.win === win) event.preventDefault(); });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.geometry = null;
      this.lastGoodGeometry = null;
      const child = this.child; this.child = null; if (child) child.kill();
      clearInterval(this.watchdog); this.watchdog = null;
      clearTimeout(this.retryTimer);
      if (this.config?.taskbar.visible) this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.config?.taskbar.visible && !this.win) this.create();
      }, 3000);
    });
    win.once('ready-to-show', () => { this.send('settings:changed', this.config); this.send('monitor:update', this.snapshot()); this.place(); });
    win.loadFile(this.html, { query: { taskbar: '1' } });
    this.startProbe(win);
  }
  startProbe(win) {
    if (!this.config?.taskbar.visible || this.win !== win || win.isDestroyed() || this.child) return;
    try {
      const handle = win.getNativeWindowHandle();
      const handleId = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      const child = spawn(this.probe, [handleId, String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child;
      let lastResponse = Date.now();
      this.watchdog = setInterval(() => {
        if (this.child === child && Date.now() - lastResponse > 12000) {
          this.geometry = null;
          this.place();
          child.kill();
        }
      }, 3000);
      this.watchdog.unref();
      child.on('error', () => { this.geometry = null; this.place(); });
      child.on('close', () => {
        if (this.child !== child) return;
        clearInterval(this.watchdog); this.watchdog = null;
        this.child = null;
        if (this.config?.taskbar.visible) this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.config?.taskbar.visible && this.win === win && !win.isDestroyed()) this.startProbe(win);
        }, 2000);
      });
      createInterface({ input: child.stdout }).on('line', line => {
        if (this.child !== child) return;
        let message;
        try { message = JSON.parse(line); } catch { message = null; }
        lastResponse = Date.now();
        if (message?.controlsAvailable && message.blocked?.length) this.lastGoodGeometry = message;
        this.geometry = retainTaskbarGeometry(this.lastGoodGeometry, message);
        this.place();
        if (message?.restartProbe) child.kill();
      });
    } catch { this.geometry = null; }
  }
  send(channel, data) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data); }
  resize(sender, size) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    const width = Number(size?.width);
    if (Number.isFinite(width) && width > 0) { this.width = Math.max(70, Math.min(1800, Math.ceil(width))); this.place(); }
  }
  place() {
    const w = this.win, g = this.geometry;
    if (!w || w.isDestroyed()) return;
    if (!this.config?.taskbar.visible || !g || !Array.isArray(g.blocked) || !g.blocked.length) { w.hide(); return; }
    const topLeft = screen.screenToDipPoint({ x: g.left, y: g.top });
    const bottomRight = screen.screenToDipPoint({ x: g.right, y: g.bottom });
    const display = screen.getDisplayNearestPoint(topLeft);
    // A hidden auto-hide taskbar moves outside the monitor; do not cover its activation edge.
    if (topLeft.y >= display.bounds.y + display.bounds.height - 4 || bottomRight.y <= display.bounds.y || bottomRight.y - topLeft.y < 20) { w.hide(); return; }
    const occupied = g.blocked.map(pair => [screen.screenToDipPoint({ x: pair[0], y: g.top }).x, screen.screenToDipPoint({ x: pair[1], y: g.top }).x]);
    const gap = chooseTaskbarGap(topLeft.x, bottomRight.x, occupied, this.width, this.config.taskbar.position);
    if (!gap) { w.hide(); return; }
    const height = Math.min(40, bottomRight.y - topLeft.y);
    const bounds = { x: Math.round(gap.x), y: Math.round(topLeft.y + (bottomRight.y - topLeft.y - height) / 2), width: Math.floor(gap.width), height: Math.floor(height) };
    const old = w.getBounds();
    if (Object.keys(bounds).some(key => bounds[key] !== old[key])) w.setBounds(bounds, false);
    if (!w.isVisible()) { w.setSkipTaskbar(true); this.taskbarRefreshAt = Date.now(); w.showInactive(); }
    else if (Date.now() - this.taskbarRefreshAt > 15000) { w.setSkipTaskbar(true); this.taskbarRefreshAt = Date.now(); }
    // If Windows rejects the owner relationship, periodically raise the passive
    // window as a fallback. An attached window follows the taskbar's z-order.
    if (!g.attached) w.moveTop();
  }
  stop() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearInterval(this.watchdog); this.watchdog = null;
    const child = this.child; this.child = null; if (child) child.kill();
    const win = this.win; this.win = null; if (win && !win.isDestroyed()) win.destroy();
    this.geometry = null;
    this.lastGoodGeometry = null;
  }
}
