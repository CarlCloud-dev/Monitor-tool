import { EventEmitter } from 'node:events';
import si from 'systeminformation';
import { LhmBridge } from './lhm-bridge.js';
import { WindowsPerfSampler } from './windows-perf-sampler.js';

const isFiniteNumber = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const numberOrNull = (value) => (isFiniteNumber(value) ? Number(value) : null);
const nonZeroNumberOrNull = (value) => {
  const numeric = numberOrNull(value);
  return numeric && numeric > 0 ? numeric : null;
};

const metric = (id, label, value, unit, detail, group, icon) => ({
  id,
  label,
  value: numberOrNull(value),
  unit,
  detail,
  group,
  icon
});

const formatBytes = (bytes) => {
  if (!isFiniteNumber(bytes)) return '—';
  const gigabytes = Number(bytes) / 1024 ** 3;
  return gigabytes >= 10 ? `${gigabytes.toFixed(0)} GB` : `${gigabytes.toFixed(1)} GB`;
};

const formatSpeed = (bytesPerSecond, unit = 'MB/s') => {
  if (!isFiniteNumber(bytesPerSecond)) return '—';
  const amount = Number(bytesPerSecond) / (unit === 'KB/s' ? 1024 : 1024 ** 2);
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
};

const sensorValue = (sensor, { zeroIsValid = false } = {}) => {
  const numeric = numberOrNull(sensor?.value);
  if (numeric === null || (!zeroIsValid && numeric <= 0)) return null;
  return numeric;
};
const sensorDetail = (sensor, fallback, options) => sensorValue(sensor, options) !== null
  ? `LHM · ${sensor.hardwareName} · ${sensor.name}`
  : fallback;
const isGpuSensor = (sensor) => /^gpu/i.test(sensor?.hardwareType ?? '');
const looksIntegratedGpu = (sensor) => /radeon\(tm\) graphics|intel.*(graphics|uhd|iris)/i.test(sensor?.hardwareName ?? '');
const isCpuTemperatureSensor = (sensor) => sensor.hardwareType === 'Cpu' && sensor.sensorType === 'Temperature';
const isCpuPowerSensor = (sensor) => sensor.hardwareType === 'Cpu' && sensor.sensorType === 'Power';
const isCpuFanSensor = (sensor) => sensor.sensorType === 'Fan' && /cpu|processor/i.test(sensor.name ?? '');
const isBoardSensor = (sensor) => sensor.sensorType === 'Temperature' && (
  ['Motherboard', 'SuperIO', 'EmbeddedController'].includes(sensor.hardwareType)
  || sensor.parentHardwareType === 'Motherboard'
);

const selectSensor = (sensors, predicate, priorityNames = [], valueOptions) => {
  const candidates = sensors.filter((sensor) => predicate(sensor) && sensorValue(sensor, valueOptions) !== null);
  if (!candidates.length) return null;
  const priorityScore = (sensor) => {
    const name = sensor.name?.toLowerCase() ?? '';
    const found = priorityNames.findIndex((pattern) => pattern.test(name));
    return found < 0 ? priorityNames.length : found;
  };
  return candidates.sort((left, right) => priorityScore(left) - priorityScore(right))[0];
};

const selectPrimaryGpuSensors = (sensors) => {
  const groups = new Map();
  for (const sensor of sensors.filter(isGpuSensor)) {
    const key = `${sensor.hardwareType}:${sensor.hardwareName}`;
    const group = groups.get(key) ?? [];
    group.push(sensor);
    groups.set(key, group);
  }

  const ranked = [...groups.values()].sort((left, right) => {
    const score = (group) => {
      const representative = group[0];
      const hasNvidia = /^gpuNvidia$/i.test(representative.hardwareType ?? '');
      const dedicatedName = !looksIntegratedGpu(representative);
      const hasPackagePower = group.some((sensor) => sensor.sensorType === 'Power' && /gpu package|board power|total/i.test(sensor.name ?? ''));
      return (hasNvidia ? 100 : 0) + (dedicatedName ? 20 : 0) + (hasPackagePower ? 10 : 0);
    };
    return score(right) - score(left);
  });

  return ranked[0] ?? [];
};

const readLhmSensors = (sensors) => {
  const gpuSensors = selectPrimaryGpuSensors(sensors);
  return {
    cpuTemp: selectSensor(sensors, isCpuTemperatureSensor, [/package/, /tctl|tdie/, /cpu/]),
    cpuPower: selectSensor(sensors, isCpuPowerSensor, [/package/, /cpu/]),
    cpuFan: selectSensor(sensors, isCpuFanSensor, [/cpu/, /fan/], { zeroIsValid: true }),
    gpuTemp: selectSensor(gpuSensors, (sensor) => sensor.sensorType === 'Temperature', [/gpu core/, /core/]),
    gpuLoad: selectSensor(gpuSensors, (sensor) => sensor.sensorType === 'Load', [/gpu core/, /core/]),
    gpuPower: selectSensor(gpuSensors, (sensor) => sensor.sensorType === 'Power', [/gpu package/, /board power/, /package/]),
    gpuFan: selectSensor(gpuSensors, (sensor) => sensor.sensorType === 'Fan', [/gpu fan 1/, /gpu/, /fan/], { zeroIsValid: true }),
    boardTemp: selectSensor(sensors, isBoardSensor, [/system/, /motherboard/, /chipset|pch/, /vrm/, /t_sensor/])
  };
};

const sensorAvailability = (sensors, predicate, valueOptions) => {
  const matches = sensors.filter(predicate);
  if (!matches.length) return 'missing';
  return matches.some((sensor) => sensorValue(sensor, valueOptions) !== null) ? 'ready' : 'invalid';
};

const summarizeLhmSensors = (sensors) => ({
  count: sensors.length,
  cpuTemp: sensorAvailability(sensors, isCpuTemperatureSensor),
  cpuPower: sensorAvailability(sensors, isCpuPowerSensor),
  cpuFan: sensorAvailability(sensors, isCpuFanSensor, { zeroIsValid: true }),
  boardTemp: sensorAvailability(sensors, isBoardSensor)
});

const enhancedSensorDetail = (summary, status, mode, runtime) => {
  if (status === 'starting') return '正在启动本地采集器…';
  if (status === 'error' && Number(runtime?.retryInMs) > 0) {
    return '增强采集器暂不可用，将在 ' + Math.ceil(Number(runtime.retryInMs) / 1000) + ' 秒后重试。';
  }
  if (status !== 'ready') return '增强采集器未就绪。';
  const describe = (label, state) => `${label}${state === 'ready' ? '已读取' : state === 'invalid' ? '已识别但数值无效' : '未上报'}`;
  const modeLabel = mode === 'elevated' ? '管理员增强' : '标准采集';
  const library = runtime?.lhmVersion ? `LHM ${runtime.lhmVersion}` : 'LHM';
  const requirement = mode === 'elevated' && runtime?.pawnIoInstalled === false
    ? '未检测到 PawnIO 底层传感器驱动；主板温度和主板风扇无法读取。'
    : null;
  return `${modeLabel} · ${library} · 共读取 ${summary.count} 项 · ${[
    describe('CPU 温度：', summary.cpuTemp),
    describe('CPU 功耗：', summary.cpuPower),
    describe('CPU 风扇：', summary.cpuFan),
    describe('主板温度：', summary.boardTemp)
  ].join('，')}${requirement ? `。${requirement}` : ''}`;
};

const HISTORY_METRICS = ['cpu.load', 'cpu.temp', 'memory.load', 'gpu.load', 'gpu.temp'];
const HISTORY_LIMIT = 120;
const DEFAULT_HISTORY_METRICS = ['cpu.load', 'cpu.temp', 'memory.load', 'gpu.load', 'gpu.temp', 'board.temp', 'disk.load', 'network.down', 'network.up'];
const ENHANCED_METRICS = ['cpu.temp', 'cpu.power', 'cpu.fan', 'gpu.load', 'gpu.temp', 'gpu.power', 'gpu.fan', 'board.temp'];

const historyMetricSet = (metricIds) => {
  const selected = new Set(Array.isArray(metricIds) ? metricIds : []);
  return selected.size ? selected : new Set(DEFAULT_HISTORY_METRICS);
};

export class MonitorService extends EventEmitter {
  constructor({ refreshMs = 1000, lhmDirectory, lhmEnabled = false, lhmMode = 'standard', networkUnit = 'MB/s', alerts = {}, selectedMetrics = [], historyEnabled = true, historyMetrics = DEFAULT_HISTORY_METRICS } = {}) {
    super();
    this.refreshMs = refreshMs;
    this.timer = null;
    this.inFlight = false;
    this.snapshot = this.createEmptySnapshot();
    this.cache = new Map();
    this.lhmEnabled = lhmEnabled;
    this.lhmDirectory = lhmDirectory;
    this.lhmMode = lhmMode;
    this.networkUnit = networkUnit === 'KB/s' ? 'KB/s' : 'MB/s';
    this.selectedMetricIds = new Set(Array.isArray(selectedMetrics) ? selectedMetrics : []);
    this.historyEnabled = historyEnabled !== false;
    this.historyMetricIds = historyMetricSet(historyMetrics);
    this.lightweightMode = false;
    this.lhm = this.createLhmBridge();
    this.history = [];
    this.windowsPerf = new WindowsPerfSampler();
    this.lastAlertAt = new Map();
    this.setAlertPolicy(alerts);
  }

  createLhmBridge() {
    return new LhmBridge(this.lhmDirectory, { elevated: this.lhmMode === 'elevated' });
  }

  createEmptySnapshot() {
    return {
      capturedAt: Date.now(),
      health: 'checking',
      device: { cpu: '正在读取硬件信息', gpu: '正在读取显卡信息' },
      metrics: {},
      sources: { temperature: 'checking', gpu: 'checking', enhanced: 'disabled' },
      history: []
    };
  }

  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.refreshMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lhm.stop();
    this.windowsPerf.stop();
  }

  setRefreshInterval(refreshMs) {
    if (this.refreshMs === refreshMs) return;
    this.refreshMs = refreshMs;
    if (!this.timer) return;
    this.stop();
    this.start();
  }

  setLhmEnabled(enabled) {
    const next = enabled === true;
    if (next === this.lhmEnabled) return;
    this.lhmEnabled = next;
    this.cache.delete('lhm-sensors');
    if (!next) this.lhm.stop();
  }

  setLhmMode(mode) {
    const next = mode === 'elevated' ? 'elevated' : 'standard';
    if (next === this.lhmMode) return;
    this.lhmMode = next;
    this.cache.delete('lhm-sensors');
    this.lhm.stop();
    this.lhm = this.createLhmBridge();
  }

  setNetworkUnit(unit) {
    const next = unit === 'KB/s' ? 'KB/s' : 'MB/s';
    if (next === this.networkUnit) return;
    this.networkUnit = next;
    if (!this.inFlight) void this.sample();
  }

  setSelectedMetrics(metricIds = []) {
    this.selectedMetricIds = new Set(Array.isArray(metricIds) ? metricIds : []);
    this.cache.delete('lhm-sensors');
    if (this.lightweightMode && !this.inFlight) void this.sample();
  }

  setHistorySettings(settings = {}) {
    this.historyEnabled = settings.enabled !== false;
    this.historyMetricIds = historyMetricSet(settings.metricIds);
    this.cache.delete('lhm-sensors');
    if (this.lightweightMode && !this.inFlight) void this.sample();
  }

  setLightweightMode(enabled) {
    const next = enabled === true;
    if (next === this.lightweightMode) return;
    this.lightweightMode = next;
    // 轻量模式可能刚刚释放了 LHM 桥接，恢复主界面时必须立即重新连接。
    this.cache.delete('lhm-sensors');
    if (!this.inFlight) void this.sample();
  }

  restartLhmBridge() {
    this.cache.delete('lhm-sensors');
    this.lhm.stop();
    this.lhm = this.createLhmBridge();
    if (!this.inFlight) void this.sample();
  }

  setAlertPolicy(policy = {}) {
    this.alerts = {
      enabled: policy.enabled === true,
      cpuTemperature: Number(policy.cpuTemperature) || 85,
      gpuTemperature: Number(policy.gpuTemperature) || 83,
      cooldownSeconds: Number(policy.cooldownSeconds) || 300
    };
    if (!this.alerts.enabled) this.lastAlertAt.clear();
  }

  recordHistory(metrics, capturedAt) {
    this.history.push({
      capturedAt,
      values: Object.fromEntries(HISTORY_METRICS.map((id) => [id, metrics[id]?.value ?? null]))
    });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    return this.history;
  }

  checkTemperatureAlerts(metrics, capturedAt) {
    if (!this.alerts.enabled) return;
    const candidates = [
      { id: 'cpu.temp', label: 'CPU 温度', threshold: this.alerts.cpuTemperature },
      { id: 'gpu.temp', label: 'GPU 温度', threshold: this.alerts.gpuTemperature }
    ];
    for (const candidate of candidates) {
      const value = metrics[candidate.id]?.value;
      if (!Number.isFinite(value) || value < candidate.threshold) {
        this.lastAlertAt.delete(candidate.id);
        continue;
      }
      const lastAlertAt = this.lastAlertAt.get(candidate.id) ?? 0;
      if (capturedAt - lastAlertAt < this.alerts.cooldownSeconds * 1000) continue;
      this.lastAlertAt.set(candidate.id, capturedAt);
      this.emit('alert', { ...candidate, value, capturedAt });
    }
  }

  getSnapshot() {
    return this.snapshot;
  }

  async cached(key, ttlMs, loader) {
    const current = this.cache.get(key);
    if (current && Date.now() - current.at < ttlMs) return current.value;
    try {
      const value = await loader();
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return current?.value ?? null;
    }
  }

  async sample() {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const alertMetrics = this.alerts.enabled ? ['cpu.temp', 'gpu.temp'] : [];
      const shouldSample = (id) => !this.lightweightMode
        || this.selectedMetricIds.has(id)
        || (this.historyEnabled && this.historyMetricIds.has(id))
        || alertMetrics.includes(id);
      const needsMemory = shouldSample('memory.load') || shouldSample('memory.used');
      const needsGraphics = ['gpu.load', 'gpu.temp', 'gpu.vram', 'gpu.power', 'gpu.fan'].some(shouldSample);
      const needsDisk = shouldSample('disk.load');
      const needsNetwork = shouldSample('network.down') || shouldSample('network.up');
      const needsEnhanced = this.lhmEnabled && ENHANCED_METRICS.some(shouldSample);
      if (!needsEnhanced && this.lhm.getStatus().status !== 'disabled') this.lhm.stop();
      const needsWindowsPerf = needsDisk || needsNetwork;
      if (!needsWindowsPerf) this.windowsPerf.stop();
      const [load, memory, cpu, graphics, temperature, windowsPerf, lhmSensors] = await Promise.all([
        shouldSample('cpu.load') ? si.currentLoad() : null,
        needsMemory ? si.mem() : null,
        shouldSample('cpu.speed') || !this.lightweightMode ? this.cached('cpu', 60_000, () => si.cpu()) : null,
        needsGraphics ? this.cached('graphics', 2_000, () => si.graphics()) : null,
        shouldSample('cpu.temp') || this.alerts.enabled ? this.cached('cpu-temperature', 5_000, () => si.cpuTemperature()) : null,
        needsWindowsPerf ? this.cached(`windows-perf:${needsDisk}:${needsNetwork}`, 900, () => this.windowsPerf.sample({ disk: needsDisk, network: needsNetwork })) : null,
        needsEnhanced ? this.cached('lhm-sensors', 2_000, () => this.lhm.sample()) : null
      ]);

      const enhancedSensorList = lhmSensors ?? [];
      const enhanced = readLhmSensors(enhancedSensorList);
      const enhancedSummary = summarizeLhmSensors(enhancedSensorList);
      const enhancedBridgeStatus = this.lhm.getStatus();
      const pawnIoRequired = this.lhmEnabled
        && this.lhmMode === 'elevated'
        && enhancedBridgeStatus.status === 'ready'
        && enhancedBridgeStatus.pawnIoInstalled === false;
      const controller = graphics?.controllers?.find((candidate) => !/(virtual|remote|basic display|mirror)/i.test(candidate.model ?? '')) ?? null;
      const cpuLoad = numberOrNull(load?.currentLoad);
      const cpuTemp = sensorValue(enhanced.cpuTemp) ?? nonZeroNumberOrNull(temperature?.main);
      const cpuSpeed = numberOrNull(cpu?.speed);
      const memoryLoad = memory?.total ? (memory.used / memory.total) * 100 : null;
      const gpuLoad = sensorValue(enhanced.gpuLoad) ?? numberOrNull(controller?.utilizationGpu);
      const gpuTemp = sensorValue(enhanced.gpuTemp) ?? nonZeroNumberOrNull(controller?.temperatureGpu);
      const gpuMemoryTotal = numberOrNull(controller?.memoryTotal ?? controller?.vram);
      const gpuMemoryUsed = numberOrNull(controller?.memoryUsed ?? controller?.vramDynamic);
      const gpuVramLoad = gpuMemoryTotal && gpuMemoryUsed !== null ? (gpuMemoryUsed / gpuMemoryTotal) * 100 : null;
      const diskLoad = numberOrNull(windowsPerf?.diskPercent);
      const totalRx = numberOrNull(windowsPerf?.receivedBytesPerSecond);
      const totalTx = numberOrNull(windowsPerf?.sentBytesPerSecond);
      const enhancedFallback = pawnIoRequired
        ? '未检测到 PawnIO 底层传感器驱动'
        : this.lhmEnabled
        ? this.lhmMode === 'elevated'
          ? '管理员增强采集器未提供有效读数'
          : '未提供有效读数；可切换到管理员增强采集'
        : '需启用增强传感器';

      const metrics = {
        'cpu.load': metric('cpu.load', 'CPU 利用率', cpuLoad, '%', cpu?.brand ?? '处理器', 'cpu', 'cpu'),
        'cpu.temp': metric('cpu.temp', 'CPU 温度', cpuTemp, '°C', sensorDetail(enhanced.cpuTemp, cpuTemp === null ? enhancedFallback : '核心温度'), 'cpu', 'thermometer'),
        'cpu.speed': metric('cpu.speed', 'CPU 频率', cpuSpeed, 'GHz', '当前主频', 'cpu', 'activity'),
        'cpu.power': metric('cpu.power', 'CPU 功耗', sensorValue(enhanced.cpuPower), 'W', sensorDetail(enhanced.cpuPower, enhancedFallback), 'cpu', 'activity'),
        'cpu.fan': metric('cpu.fan', 'CPU 风扇', sensorValue(enhanced.cpuFan, { zeroIsValid: true }), 'RPM', sensorDetail(enhanced.cpuFan, enhancedFallback, { zeroIsValid: true }), 'cpu', 'activity'),
        'memory.load': metric('memory.load', '内存利用率', memoryLoad, '%', `${formatBytes(memory?.used)} / ${formatBytes(memory?.total)}`, 'memory', 'memory'),
        'memory.used': metric('memory.used', '内存已用', memory?.used ? memory.used / 1024 ** 3 : null, 'GB', `可用 ${formatBytes(memory?.available)}`, 'memory', 'memory'),
        'gpu.load': metric('gpu.load', 'GPU 利用率', gpuLoad, '%', sensorDetail(enhanced.gpuLoad, controller?.model ?? '显卡传感器'), 'gpu', 'gpu'),
        'gpu.temp': metric('gpu.temp', 'GPU 温度', gpuTemp, '°C', sensorDetail(enhanced.gpuTemp, gpuTemp === null ? '此驱动暂未提供温度' : controller?.model ?? '显卡温度'), 'gpu', 'thermometer'),
        'gpu.vram': metric('gpu.vram', '显存利用率', gpuVramLoad, '%', gpuMemoryTotal ? `${Math.round(gpuMemoryUsed ?? 0)} / ${Math.round(gpuMemoryTotal)} MB` : '显存数据不可用', 'gpu', 'gpu'),
        'gpu.power': metric('gpu.power', 'GPU 功耗', sensorValue(enhanced.gpuPower), 'W', sensorDetail(enhanced.gpuPower, enhancedFallback), 'gpu', 'activity'),
        'gpu.fan': metric('gpu.fan', 'GPU 风扇', sensorValue(enhanced.gpuFan, { zeroIsValid: true }), 'RPM', sensorDetail(enhanced.gpuFan, enhancedFallback, { zeroIsValid: true }), 'gpu', 'activity'),
        'board.temp': metric('board.temp', '主板温度', sensorValue(enhanced.boardTemp), '°C', sensorDetail(enhanced.boardTemp, enhancedFallback), 'board', 'thermometer'),
        'disk.load': metric('disk.load', '磁盘利用率', diskLoad, '%', diskLoad === null ? 'Windows 磁盘活动时间不可用' : 'Windows 磁盘活动时间', 'storage', 'disk'),
        'network.down': metric('network.down', '下载速率', totalRx, 'B/s', formatSpeed(totalRx, this.networkUnit), 'network', 'download'),
        'network.up': metric('network.up', '上传速率', totalTx, 'B/s', formatSpeed(totalTx, this.networkUnit), 'network', 'upload')
      };

      const temperatures = [cpuTemp, gpuTemp].filter((value) => value !== null);
      const maxTemperature = temperatures.length ? Math.max(...temperatures) : null;
      const health = maxTemperature === null ? 'partial' : maxTemperature >= 90 ? 'danger' : maxTemperature >= 80 ? 'warning' : 'normal';

      const capturedAt = Date.now();
      const history = this.recordHistory(metrics, capturedAt);
      this.checkTemperatureAlerts(metrics, capturedAt);
      this.snapshot = {
        capturedAt,
        health,
        device: {
          cpu: cpu?.brand ?? 'CPU',
          gpu: enhanced.gpuTemp?.hardwareName ?? enhanced.gpuLoad?.hardwareName ?? controller?.model ?? '未检测到可读 GPU 传感器'
        },
        metrics,
        sources: {
          temperature: temperatures.length ? 'live' : 'unavailable',
          gpu: enhanced.gpuTemp || enhanced.gpuLoad || controller ? 'live' : 'unavailable',
          enhanced: this.lhmEnabled ? enhancedBridgeStatus.status : 'disabled',
          enhancedError: this.lhmEnabled ? enhancedBridgeStatus.lastError : null,
          enhancedRuntime: this.lhmEnabled ? {
            lhmVersion: enhancedBridgeStatus.lhmVersion,
            pawnIoInstalled: enhancedBridgeStatus.pawnIoInstalled,
            pawnIoVersion: enhancedBridgeStatus.pawnIoVersion
          } : null,
          enhancedDetail: this.lhmEnabled
            ? enhancedSensorDetail(enhancedSummary, enhancedBridgeStatus.status, this.lhmMode, enhancedBridgeStatus)
            : null
        },
        history
      };
      this.emit('snapshot', this.snapshot);
    } catch (error) {
      this.emit('error', error);
    } finally {
      this.inFlight = false;
    }
  }
}
