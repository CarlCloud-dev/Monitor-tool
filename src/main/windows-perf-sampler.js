import { spawn } from 'node:child_process';

const SAMPLE_TIMEOUT_MS = 2_500;
const STARTUP_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 30_000;
const numberOrNull = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Only requested counters are queried; a disk failure must not hide network data.
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $request = ConvertFrom-Json -InputObject $line
    $result = @{
      ok = $true
      diskPercent = $null
      receivedBytesPerSecond = $null
      sentBytesPerSecond = $null
      diskError = $null
      networkError = $null
    }
    if ($request.disk) {
      try {
        $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
        if ($null -ne $disk -and $null -ne $disk.PercentDiskTime) {
          $result.diskPercent = [Math]::Min(100, [Math]::Max(0, [double]$disk.PercentDiskTime))
        }
      } catch { $result.diskError = $_.Exception.Message }
    }
    if ($request.network) {
      try {
        $counters = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop)
        if ($counters.Count -gt 0) {
          $received = ($counters | Measure-Object -Property BytesReceivedPersec -Sum).Sum
          $sent = ($counters | Measure-Object -Property BytesSentPersec -Sum).Sum
          if ($null -ne $received) { $result.receivedBytesPerSecond = [Math]::Max(0, [double]$received) }
          if ($null -ne $sent) { $result.sentBytesPerSecond = [Math]::Max(0, [double]$sent) }
        }
      } catch { $result.networkError = $_.Exception.Message }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $result))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $false; error = $_.Exception.Message }))
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
    this.failureCount = 0;
    this.retryAt = 0;
    this.hasSample = false;
  }

  get available() {
    return process.platform === 'win32';
  }

  start() {
    if (!this.available || Date.now() < this.retryAt) return false;
    if (this.process && !this.process.killed) return true;
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.recordFailure(error.message);
      return false;
    }
    this.process = child;
    this.buffer = '';
    this.hasSample = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.process === child) this.readOutput(child, chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (this.process === child) this.lastError = String(chunk).trim().slice(-400) || this.lastError;
    });
    // Every callback belongs to its child. Late events from a retired child are ignored.
    child.on('error', (error) => this.handleExit(child, error.message));
    child.stdin.on('error', (error) => this.handleExit(child, error.message));
    child.stdout.on('error', (error) => this.handleExit(child, error.message));
    child.stderr.on('error', (error) => this.handleExit(child, error.message));
    child.on('exit', (code) => this.handleExit(child, 'Windows 性能计数器进程已退出（' + (code ?? '未知错误') + '）。'));
    return true;
  }

  recordFailure(message) {
    this.lastError = message;
    this.failureCount = Math.min(this.failureCount + 1, 6);
    this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failureCount - 1));
  }

  handleExit(child, message) {
    if (this.process !== child) return;
    this.recordFailure(message);
    this.retire(child);
  }

  retire(child) {
    if (this.process !== child) return;
    this.process = null;
    this.buffer = '';
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.resolve(null);
      this.pending = null;
    }
    if (!child) return;
    try { child.stdin.destroy(); } catch { /* already closed */ }
    try { if (!child.killed) child.kill(); } catch { /* already exited */ }
  }

  readOutput(child, chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 65_536) {
      this.handleExit(child, 'Windows 性能计数器响应过大。');
      return;
    }
    let boundary = this.buffer.indexOf('\n');
    while (boundary >= 0 && this.process === child) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) this.handleMessage(child, line);
      boundary = this.buffer.indexOf('\n');
    }
  }

  handleMessage(child, line) {
    if (this.process !== child || !this.pending) return;
    let result;
    try { result = JSON.parse(line); } catch { return; }
    if (!result?.ok) {
      this.handleExit(child, result?.error || 'Windows 性能计数器读取失败。');
      return;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeout);
    this.failureCount = 0;
    this.retryAt = 0;
    this.hasSample = true;
    this.lastError = [result.diskError, result.networkError].filter(Boolean).join('；') || null;
    const disk = numberOrNull(result.diskPercent);
    const received = numberOrNull(result.receivedBytesPerSecond);
    const sent = numberOrNull(result.sentBytesPerSecond);
    pending.resolve({
      diskPercent: pending.disk && disk !== null ? Math.max(0, Math.min(100, disk)) : null,
      receivedBytesPerSecond: pending.network && received !== null ? Math.max(0, received) : null,
      sentBytesPerSecond: pending.network && sent !== null ? Math.max(0, sent) : null
    });
  }

  async sample({ disk = true, network = true } = {}) {
    if (!disk && !network) {
      this.stop();
      return null;
    }
    if (this.pending) {
      const pending = this.pending;
      if ((!disk || pending.disk) && (!network || pending.network)) return pending.promise;
      await pending.promise;
      return this.sample({ disk, network });
    }
    if (!this.start()) return null;
    const child = this.process;
    if (!child?.stdin?.writable) {
      if (child) this.handleExit(child, 'Windows 性能计数器输入管道已关闭。');
      return null;
    }
    let resolveSample;
    const promise = new Promise((resolve) => { resolveSample = resolve; });
    const timeout = setTimeout(() => {
      if (this.pending?.promise === promise) this.handleExit(child, 'Windows 性能计数器读取超时。');
    }, this.hasSample ? SAMPLE_TIMEOUT_MS : STARTUP_TIMEOUT_MS);
    this.pending = { promise, resolve: resolveSample, timeout, disk, network };
    try {
      child.stdin.write(JSON.stringify({ disk, network }) + '\n', (error) => {
        if (error) this.handleExit(child, error.message);
      });
    } catch (error) {
      this.handleExit(child, error.message || '无法向 Windows 性能计数器发送请求。');
    }
    return promise;
  }

  stop() {
    this.retire(this.process);
    this.failureCount = 0;
    this.retryAt = 0;
  }
}
