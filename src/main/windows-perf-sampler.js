import { spawn } from 'node:child_process';

const SAMPLE_TIMEOUT_MS = 2_500;

// Keep one PowerShell process alive and query both counters in one round trip.
// This avoids starting a new powershell.exe for every disk/network refresh.
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
while ($true) {
  $request = [Console]::In.ReadLine()
  if ($null -eq $request) { break }
  try {
    $diskCounter = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop |
      Where-Object { $_.Name -eq '_Total' } |
      Select-Object -First 1
    $networkCounters = Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop
    $received = [double](($networkCounters | Measure-Object -Property BytesReceivedPersec -Sum).Sum)
    $sent = [double](($networkCounters | Measure-Object -Property BytesSentPersec -Sum).Sum)
    $diskPercent = if ($null -eq $diskCounter) { $null } else { [double]$diskCounter.PercentDiskTime }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{
      ok = $true
      diskPercent = $diskPercent
      receivedBytesPerSecond = $received
      sentBytesPerSecond = $sent
    }))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{
      ok = $false
      error = $_.Exception.Message
    }))
  }
  [Console]::Out.Flush()
}
`;

export class WindowsPerfSampler {
  constructor() {
    this.process = null;
    this.buffer = '';
    this.pending = null;
    this.lastError = null;
  }

  get available() {
    return process.platform === 'win32';
  }

  start() {
    if (!this.available) return false;
    if (this.process && !this.process.killed) return true;
    this.lastError = null;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      POWERSHELL_SCRIPT
    ], {
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
    child.on('exit', (code) => this.handleExit(code === 0 ? null : 'Windows 性能计数器进程已退出（' + (code ?? '未知错误') + '）。'));
    return true;
  }

  handleExit(message) {
    const child = this.process;
    this.process = null;
    this.buffer = '';
    if (message) this.lastError = message;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.resolve(null);
      this.pending = null;
    }
    if (child && !child.killed) child.kill();
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
    if (!this.pending) return;
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      return;
    }
    clearTimeout(this.pending.timeout);
    const resolve = this.pending.resolve;
    this.pending = null;
    if (!result?.ok) {
      this.lastError = result?.error || 'Windows 性能计数器读取失败。';
      resolve(null);
      return;
    }
    resolve({
      diskPercent: Number.isFinite(Number(result.diskPercent)) ? Number(result.diskPercent) : null,
      receivedBytesPerSecond: Number.isFinite(Number(result.receivedBytesPerSecond))
        ? Number(result.receivedBytesPerSecond)
        : null,
      sentBytesPerSecond: Number.isFinite(Number(result.sentBytesPerSecond))
        ? Number(result.sentBytesPerSecond)
        : null
    });
  }

  async sample() {
    if (!this.start() || !this.process?.stdin?.writable) return null;
    if (this.pending) return this.pending.promise;
    let resolveSample;
    const promise = new Promise((resolve) => { resolveSample = resolve; });
    const timeout = setTimeout(() => {
      if (!this.pending) return;
      this.pending.resolve(null);
      this.pending = null;
      this.lastError = 'Windows 性能计数器读取超时。';
      this.stop();
    }, SAMPLE_TIMEOUT_MS);
    this.pending = { promise, resolve: resolveSample, timeout };
    try {
      this.process.stdin.write('sample\n');
    } catch (error) {
      clearTimeout(timeout);
      this.pending = null;
      this.lastError = error?.message || '无法向 Windows 性能计数器发送请求。';
      this.stop();
      resolveSample(null);
    }
    return promise;
  }

  stop() {
    const child = this.process;
    this.process = null;
    this.buffer = '';
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.resolve(null);
      this.pending = null;
    }
    if (!child) return;
    try { child.stdin.end(); } catch { /* process may already be closed */ }
    if (!child.killed) child.kill();
  }
}
