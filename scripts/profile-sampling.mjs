import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MonitorService } from '../src/main/monitor-service.js';

// Read-only live diagnostic: no application settings or history files are written.
// Use the standard bridge to avoid opening an administrator approval dialog.
const root = fileURLToPath(new URL('../', import.meta.url));
const settingsPath = path.join(process.env.APPDATA ?? '', 'monitor-tool', 'monitor-tool.settings.json');
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
const secondsIndex = process.argv.indexOf('--seconds');
const durationSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 30;
if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 120) throw new Error('--seconds must be between 5 and 120');
const idle = process.argv.includes('--idle');
const service = new MonitorService({
  refreshMs: settings.refreshMs,
  lhmDirectory: path.join(root, 'resources', 'lhm'),
  lhmEnabled: !process.argv.includes('--no-enhanced') && settings.sensors.lhmEnabled,
  lhmMode: 'standard',
  selectedMetrics: settings.overlay.metrics,
  overlayVisible: !idle && settings.overlay.visible,
  historyEnabled: !idle && settings.history.enabled,
  historyMetrics: settings.history.metricIds,
  alerts: idle ? { enabled: false } : settings.alerts
});
service.setLightweightMode(!process.argv.includes('--full'));
let samples = 0;
const failures = [];
service.on('snapshot', () => { samples++; });
service.on('error', (error) => failures.push(error.message));
try {
  console.log(JSON.stringify({ phase: 'starting', pid: process.pid, mode: service.lightweightMode ? 'lightweight' : 'full' }));
  service.start();
  await sleep(8000);
  const initialCpu = process.cpuUsage();
  const started = performance.now();
  const initialSamples = samples;
  console.log(JSON.stringify({ phase: 'measuring', pid: process.pid }));
  await sleep(durationSeconds * 1000);
  const cpu = process.cpuUsage(initialCpu);
  const snapshot = service.getSnapshot();
  console.log(JSON.stringify({
    phase: 'complete', samples: samples - initialSamples,
    nodeCpuPercent: (cpu.user + cpu.system) / 1000 / (performance.now() - started) / os.availableParallelism() * 100,
    enhanced: snapshot.sources.enhanced,
    availableMetrics: Object.values(snapshot.metrics).filter((metric) => metric.value !== null).map((metric) => metric.id),
    failures
  }));
} finally {
  service.stop();
}
