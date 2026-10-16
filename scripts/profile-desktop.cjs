// Run with: node_modules\electron\dist\electron.exe scripts\profile-desktop.cjs
// Temporary live diagnostic: real overlay, tray and sampling; isolated user data,
// no startup registration changes, no administrator prompt, automatic exit.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { format } = require('node:util');
const { pathToFileURL } = require('node:url');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reportPath = path.join(os.tmpdir(), 'MonitorTool-desktop-' + process.pid + '.jsonl');
const report = (value) => {
  try { fs.appendFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', 'utf8'); }
  catch { /* Logging must never interrupt shutdown or open an Electron error dialog. */ }
};
// A GUI process can outlive the shell that launched it. Its stdout/stderr may
// already be closed by the time the measurement completes. Keep all diagnostic
// logging in a file, including console messages from the imported application.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => report({ phase: 'log', level, message: format(...args) });
}
process.stdout.on('error', (error) => report({ phase: 'output-error', stream: 'stdout', code: error.code }));
process.stderr.on('error', (error) => report({ phase: 'output-error', stream: 'stderr', code: error.code }));
let deadline;

(async () => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'MonitorTool-profile-'));
  app.getAppPath = () => path.resolve(__dirname, '..');
  app.setPath('userData', temporaryData);
  const ignoreLoginSettings = () => {};
  app.setLoginItemSettings = ignoreLoginSettings;
  if (app.setLoginItemSettings !== ignoreLoginSettings) throw new Error('Unable to isolate startup registration');
  const sourceUrl = (file) => pathToFileURL(path.resolve(__dirname, '..', 'src', 'main', file)).href;
  const { ConfigStore, normalizeConfig } = await import(sourceUrl('config-store.js'));
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'monitor-tool', 'monitor-tool.settings.json'), 'utf8'));
  const config = normalizeConfig(settings);
  config.sensors.lhmMode = 'standard';
  config.behavior.launchAtLogin = true;
  config.behavior.minimizeToTray = true;
  config.behavior.lightweightMode = true;
  config.overlay.visible = true;
  ConfigStore.prototype.load = async () => structuredClone(config);
  process.argv.push('--monitor-tool-autostart');
  report({ phase: 'starting', pid: process.pid, temporaryData, sensors: 'standard' });
  deadline = setTimeout(() => {
    report({ phase: 'timeout' });
    app.quit();
  }, 60_000);
  await import(sourceUrl('main.js'));
  await app.whenReady();
  await wait(8000);
  if (process.argv.includes('--panel')) {
    app.emit('activate');
    await wait(2000);
  }
  const windows = BrowserWindow.getAllWindows();
  report({
    phase: 'measuring', pid: process.pid,
    windows: windows.map((window) => ({ url: window.webContents.getURL().split('/').slice(-2).join('/'), visible: window.isVisible(), bounds: window.getContentBounds() }))
  });
  await wait(30_000);
  const overlay = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/overlay/'));
  const diagnostics = overlay ? await overlay.webContents.executeJavaScript(`(async () => {
    const snapshot = await window.monitorApi.getSnapshot();
    return {
      renderedMetrics: document.querySelectorAll('[data-metric-id]').length,
      availableMetrics: Object.values(snapshot.metrics).filter((metric) => metric.value !== null).map((metric) => metric.id),
      enhanced: snapshot.sources.enhanced
    };
  })()`) : null;
  report({ phase: 'complete', diagnostics });
})().catch((error) => {
  report({ phase: 'error', message: error.stack || error.message });
  app.exit(1);
}).finally(() => {
  clearTimeout(deadline);
  app.quit();
});
