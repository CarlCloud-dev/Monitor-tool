import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { chooseTaskbarGap, retainTaskbarGeometry } from '../src/main/taskbar-layout.js';
import { taskbarContent, formatTaskbarValue } from '../src/main/taskbar-content.js';
let now = 0;
const timers = new Map();
const schedule = (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.set(timer, timer); return timer; };
const clear = timer => timers.delete(timer);
const children = [], commands = [];
const spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = (line, callback) => { commands.push(JSON.parse(line)); callback?.(); };
  child.kill = () => { child.killed = true; };
  children.push(child); return child;
};
const source = readFileSync(new URL('../src/main/taskbar-monitor.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class TaskbarMonitor', 'class TaskbarMonitor');
const TaskbarMonitor = vm.runInNewContext(`${source}\nTaskbarMonitor`, {
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }), console,
  spawn, createInterface: ({ input }) => input, chooseTaskbarGap, retainTaskbarGeometry, taskbarContent,
  process: { pid: 1, platform: 'win32' }, Date: class extends Date { static now() { return now; } },
  setTimeout: schedule, setInterval: schedule, clearTimeout: clear, clearInterval: clear
});
const config = { theme: 'dark', taskbar: { visible: true, position: 'left' }, overlay: { metrics: ['cpu.load', 'gpu.vram.used'] } };
const snapshot = { metrics: {
  'cpu.load': { id: 'cpu.load', group: 'cpu', value: 95, unit: '%' },
  'gpu.vram.used': { id: 'gpu.vram.used', group: 'gpu', value: 3.25, unit: 'GB' }
} };
const monitor = new TaskbarMonitor({ probe: 'probe.exe', snapshot: () => snapshot });
monitor.update(config);
const host = monitor.host, firstProbe = monitor.child;
assert.notEqual(host, firstProbe);
const geometry = { shell: 12, left: 0, top: 950, right: 1000, bottom: 1000, controlsAvailable: true, blocked: [[0, 200], [850, 1000]] };
host.stdout.emit('line', JSON.stringify({ kind: 'size', width: 200, height: 40 }));
firstProbe.stdout.emit('line', JSON.stringify(geometry));
assert.equal(commands.at(-1).kind, 'place');
const count = commands.length;
now = 13000; monitor.watchdog.fn();
assert.equal(firstProbe.killed, true); assert.equal(host.killed, undefined);
assert.equal(commands.length, count);
firstProbe.emit('close'); const recovery = monitor.recoveryTimeout;
monitor.retryTimer.fn(); const secondProbe = monitor.child;
secondProbe.stdout.emit('line', '{invalid');
assert.equal(monitor.recoveryTimeout, recovery); assert.equal(commands.length, count);
secondProbe.stdout.emit('line', JSON.stringify({ ...geometry, controlsAvailable: false, blocked: [] }));
assert.equal(monitor.recoveryTimeout, null); assert.equal(timers.has(recovery), false);
assert.equal(commands.length, count);
secondProbe.emit('close'); const deadline = monitor.recoveryTimeout;
monitor.retryTimer.fn(); monitor.child.emit('close');
assert.equal(monitor.recoveryTimeout, deadline);
deadline.fn(); assert.equal(commands.at(-1).kind, 'hide');
monitor.retryTimer.fn(); monitor.child.stdout.emit('line', JSON.stringify(geometry));
assert.equal(commands.at(-1).kind, 'place');
monitor.child.stdout.emit('line', 'null'); assert.equal(commands.at(-1).kind, 'hide');
// Native host crash recreates only the native host, and sends its content again.
host.emit('close'); monitor.hostRetryTimer.fn();
assert.notEqual(monitor.host, host);
monitor.host.stdout.emit('line', JSON.stringify({kind:'ready'}));
assert.ok(commands.slice(count).some(c => c.kind === 'content'));
monitor.stop(); assert.equal(monitor.host, null); assert.equal(monitor.child, null);
assert.equal(monitor.recoveryTimeout, null);
const content = taskbarContent(config, snapshot, true);
assert.equal(content.runs[0].text, 'CPU'); assert.notEqual(content.runs[0].color, content.runs[1].color);
assert.equal(content.runs[1].color, '#ff7777');
assert.equal(content.runs.at(-1).text, '3.3 GB');
assert.ok(!content.runs.at(-1).text.endsWith('|'));
assert.equal(taskbarContent({...config,theme:'system'}, snapshot, false).dark, false);
assert.equal(formatTaskbarValue({value:0,unit:'GB'}), '0.0 GB');
assert.equal(formatTaskbarValue({value:null,unit:'GB'}), '—');
console.log('Native taskbar content, isolated probe/host recovery, bounded timeout and cleanup checks passed');
