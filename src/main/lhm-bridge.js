import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const READY_TIMEOUT_MS = 4_000;
const ELEVATED_READY_TIMEOUT_MS = 12_000;
const SAMPLE_TIMEOUT_MS = 2_500;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

export class LhmBridge {
  constructor(directory, { elevated = false } = {}) {
    this.directory = path.resolve(directory);
    this.elevated = elevated;
    this.process = null;
    this.socket = null;
    this.writeCommand = null;
    this.buffer = '';
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.pendingSample = null;
    this.status = 'disabled';
    this.lastError = null;
    this.runtime = { lhmVersion: null, pawnIoInstalled: null, pawnIoVersion: null };
    this.intentionalStop = false;
  }

  get executablePath() {
    return path.join(this.directory, this.elevated ? 'MonitorLhmElevatedBridge.exe' : 'MonitorLhmBridge.exe');
  }

  getStatus() {
    return { status: this.status, lastError: this.lastError, elevated: this.elevated, ...this.runtime };
  }

  async start() {
    if (this.status === 'ready') return true;
    if (this.readyPromise) return this.readyPromise;

    try {
      await access(this.executablePath);
    } catch {
      this.status = 'unavailable';
      this.lastError = this.elevated
        ? '未找到管理员增强采集器。'
        : '未找到 Libre Hardware Monitor 桥接组件。';
      return false;
    }

    this.status = 'starting';
    this.lastError = null;
    this.intentionalStop = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const timeout = setTimeout(() => {
      if (this.status !== 'ready') this.failStart(this.elevated
        ? '等待管理员增强采集器连接超时。'
        : '启动 Libre Hardware Monitor 超时。');
    }, this.elevated ? ELEVATED_READY_TIMEOUT_MS : READY_TIMEOUT_MS);

    try {
      if (this.elevated) void this.startElevated().catch((error) => this.failStart(error.message));
      else this.startStandard();
      await this.readyPromise;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      this.readyPromise = null;
      this.resolveReady = null;
      this.rejectReady = null;
    }
  }

  startStandard() {
    const child = spawn(this.executablePath, [], {
      cwd: this.directory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.readOutput(chunk));
    child.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).trim().slice(-400) || this.lastError;
    });
    child.on('error', (error) => this.handleExit(error.message));
    child.on('exit', (code) => this.handleExit(code === 0 ? null : `桥接进程已退出（${code ?? '未知错误'}）。`));
    this.writeCommand = (command) => child.stdin.write(command);
  }

  async startElevated() {
    const pipeName = `monitor-tool-lhm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const command = `Start-Process -FilePath ${powerShellQuote(this.executablePath)} -ArgumentList ${powerShellQuote(`--pipe ${pipeName}`)} -Verb RunAs -WindowStyle Hidden`;
    const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      cwd: this.directory,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).trim().slice(-400) || this.lastError;
    });
    launcher.on('error', (error) => {
      if (this.status === 'starting') this.failStart(error.message);
    });
    launcher.on('exit', (code) => {
      if (code !== 0 && this.status === 'starting') this.failStart('管理员授权被取消或采集器未能启动。');
    });

    const socket = await this.waitForElevatedPipe(pipeName);
    if (this.status === 'error') {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.readOutput(chunk));
    socket.on('error', (error) => {
      this.lastError = error.message;
    });
    socket.on('close', () => this.handleExit('管理员增强采集器已停止。'));
    this.writeCommand = (commandToSend) => socket.write(commandToSend);
  }

  async waitForElevatedPipe(pipeName) {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const deadline = Date.now() + ELEVATED_READY_TIMEOUT_MS - 600;
    let latestError = null;
    while (Date.now() < deadline && this.status === 'starting') {
      try {
        return await new Promise((resolve, reject) => {
          const socket = net.createConnection(pipePath);
          const onError = (error) => {
            socket.destroy();
            reject(error);
          };
          socket.once('error', onError);
          socket.once('connect', () => {
            socket.removeListener('error', onError);
            resolve(socket);
          });
        });
      } catch (error) {
        latestError = error;
        await wait(160);
      }
    }
    throw new Error(latestError?.message || '管理员增强采集器未创建通信通道。');
  }

  failStart(message) {
    if (this.status === 'error') return;
    this.status = 'error';
    this.lastError = message;
    this.rejectReady?.(new Error(message));
    this.writeCommand = null;
    this.socket?.destroy();
    this.socket = null;
    if (this.process && !this.process.killed) this.process.kill();
  }

  handleExit(message) {
    const wasIntentional = this.intentionalStop;
    this.process = null;
    this.socket = null;
    this.writeCommand = null;
    if (wasIntentional || this.status === 'error') return;
    if (this.status !== 'ready') this.failStart(message ?? 'Libre Hardware Monitor 无法启动。');
    else {
      this.status = 'error';
      this.lastError = message ?? 'Libre Hardware Monitor 已停止。';
    }
    if (this.pendingSample) {
      clearTimeout(this.pendingSample.timeout);
      this.pendingSample.resolve(null);
      this.pendingSample = null;
    }
  }

  readOutput(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) this.handleMessage(line);
      boundary = this.buffer.indexOf('\n');
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.kind === 'ready') {
      this.runtime = {
        lhmVersion: typeof message.lhmVersion === 'string' ? message.lhmVersion : null,
        pawnIoInstalled: typeof message.pawnIoInstalled === 'boolean' ? message.pawnIoInstalled : null,
        pawnIoVersion: typeof message.pawnIoVersion === 'string' ? message.pawnIoVersion : null
      };
      this.status = 'ready';
      this.resolveReady?.();
      return;
    }
    if (message.kind === 'error') {
      this.lastError = message.message || 'Libre Hardware Monitor 返回错误。';
      if (this.status !== 'ready') this.failStart(this.lastError);
      return;
    }
    if (message.kind === 'snapshot' && this.pendingSample) {
      clearTimeout(this.pendingSample.timeout);
      this.pendingSample.resolve(Array.isArray(message.sensors) ? message.sensors : []);
      this.pendingSample = null;
    }
  }

  async sample() {
    if (this.pendingSample) return this.pendingSample.promise;
    if (!(await this.start())) return null;
    if (!this.writeCommand) return null;

    let resolveSample;
    const promise = new Promise((resolve) => { resolveSample = resolve; });
    const timeout = setTimeout(() => {
      if (!this.pendingSample) return;
      this.pendingSample.resolve(null);
      this.pendingSample = null;
      this.status = 'error';
      this.lastError = '等待硬件传感器数据超时。';
    }, SAMPLE_TIMEOUT_MS);
    this.pendingSample = { promise, resolve: resolveSample, timeout };
    this.writeCommand('sample\n');
    return promise;
  }

  stop() {
    this.intentionalStop = true;
    if (this.pendingSample) {
      clearTimeout(this.pendingSample.timeout);
      this.pendingSample.resolve(null);
      this.pendingSample = null;
    }
    try {
      this.writeCommand?.('quit\n');
    } catch {
      // 通信通道已断开时，进程和套接字会在下方一并释放。
    }
    this.socket?.end();
    this.socket?.destroy();
    if (this.process && !this.process.killed) {
      const child = this.process;
      child.stdin.end('quit\n');
      setTimeout(() => {
        if (!child.killed) child.kill();
      }, 750).unref();
    }
    this.process = null;
    this.socket = null;
    this.writeCommand = null;
    this.status = 'disabled';
    this.lastError = null;
  }
}
