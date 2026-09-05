import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  version: 14,
  theme: 'dark',
  refreshMs: 1000,
  sensors: {
    lhmEnabled: true,
    lhmMode: 'standard'
  },
  behavior: {
    minimizeToTray: true,
    lightweightMode: true
  },
  network: {
    unit: 'MB/s'
  },
  history: {
    enabled: true,
    retentionHours: 24
  },
  alerts: {
    enabled: false,
    cpuTemperature: 85,
    gpuTemperature: 83,
    cooldownSeconds: 300
  },
  overlay: {
    visible: true,
    alwaysOnTop: true,
    locked: false,
    opacity: 0.94,
    scale: 1,
    cornerRadius: 0,
    mode: 'top',
    topStyle: 'minimal',
    sidePosition: 'right',
    sideColumns: 1,
    bounds: null,
    metrics: ['cpu.load', 'cpu.temp', 'memory.load', 'gpu.load', 'gpu.temp']
  }
});

const OVERLAY_METRICS = new Set([
  'cpu.load',
  'cpu.temp',
  'cpu.speed',
  'cpu.power',
  'cpu.fan',
  'memory.load',
  'memory.used',
  'gpu.load',
  'gpu.temp',
  'gpu.vram',
  'gpu.power',
  'gpu.fan',
  'board.temp',
  'disk.load',
  'network.down',
  'network.up'
]);
const CORNER_RADII = [0, 8, 18];

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
};

const cornerRadiusFor = (value) => {
  const radius = clamp(value, 0, 24, DEFAULT_CONFIG.overlay.cornerRadius);
  return CORNER_RADII.reduce((nearest, candidate) => Math.abs(candidate - radius) < Math.abs(nearest - radius) ? candidate : nearest, CORNER_RADII[0]);
};

const validBounds = (value) => {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
};

export function normalizeConfig(value = {}) {
  const overlay = value.overlay ?? {};
  const storedVersion = Number(value.version ?? 0);
  const isPreEnhancedDefaultConfig = storedVersion < 2;
  const isPreAdaptiveSizingConfig = storedVersion < 7;
  const metrics = Array.isArray(overlay.metrics)
    ? [...new Set(overlay.metrics.filter((metric) => OVERLAY_METRICS.has(metric)))]
    : DEFAULT_CONFIG.overlay.metrics;

  return {
    version: 14,
    theme: ['dark', 'light', 'system'].includes(value.theme) ? value.theme : DEFAULT_CONFIG.theme,
    refreshMs: Math.round(clamp(value.refreshMs, 500, 5000, DEFAULT_CONFIG.refreshMs)),
    sensors: {
      lhmEnabled: isPreEnhancedDefaultConfig ? true : value.sensors?.lhmEnabled !== false,
      lhmMode: value.sensors?.lhmMode === 'elevated' ? 'elevated' : 'standard'
    },
    behavior: {
      minimizeToTray: value.behavior?.minimizeToTray !== false,
      lightweightMode: value.behavior?.lightweightMode !== false
    },
    network: {
      unit: value.network?.unit === 'KB/s' ? 'KB/s' : 'MB/s'
    },
    history: {
      enabled: value.history?.enabled !== false,
      retentionHours: [1, 6, 24, 72, 168, 720].includes(Number(value.history?.retentionHours))
        ? Number(value.history.retentionHours)
        : DEFAULT_CONFIG.history.retentionHours
    },
    alerts: {
      enabled: value.alerts?.enabled === true,
      cpuTemperature: Math.round(clamp(value.alerts?.cpuTemperature, 50, 105, DEFAULT_CONFIG.alerts.cpuTemperature)),
      gpuTemperature: Math.round(clamp(value.alerts?.gpuTemperature, 50, 105, DEFAULT_CONFIG.alerts.gpuTemperature)),
      cooldownSeconds: Math.round(clamp(value.alerts?.cooldownSeconds, 60, 3600, DEFAULT_CONFIG.alerts.cooldownSeconds))
    },
    overlay: {
      visible: overlay.visible !== false,
      alwaysOnTop: overlay.alwaysOnTop !== false,
      locked: overlay.locked === true,
      opacity: clamp(overlay.opacity, 0.55, 1, DEFAULT_CONFIG.overlay.opacity),
      scale: clamp(overlay.scale, 0.8, 1.25, DEFAULT_CONFIG.overlay.scale),
      cornerRadius: cornerRadiusFor(overlay.cornerRadius),
      mode: ['top', 'side'].includes(overlay.mode) ? overlay.mode : DEFAULT_CONFIG.overlay.mode,
      topStyle: ['minimal', 'detailed'].includes(overlay.topStyle)
        ? overlay.topStyle
        : overlay.layout === 'standard' ? 'detailed' : DEFAULT_CONFIG.overlay.topStyle,
      sidePosition: ['left', 'right'].includes(overlay.sidePosition)
        ? overlay.sidePosition
        : DEFAULT_CONFIG.overlay.sidePosition,
      sideColumns: [1, 2].includes(Number(overlay.sideColumns))
        ? Number(overlay.sideColumns)
        : DEFAULT_CONFIG.overlay.sideColumns,
      // Earlier layouts persisted programmatic placement; recalculate the adaptive mode position once.
      bounds: isPreAdaptiveSizingConfig ? null : validBounds(overlay.bounds),
      metrics: metrics.length ? metrics : DEFAULT_CONFIG.overlay.metrics
    }
  };
}

export class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'monitor-tool.settings.json');
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const stored = JSON.parse(raw);
      const config = normalizeConfig(stored);

      // Persist schema upgrades so migrated sensor defaults survive later restarts.
      if (stored.version !== config.version) {
        await this.save(config);
      }

      return config;
    } catch {
      return normalizeConfig(DEFAULT_CONFIG);
    }
  }

  async save(draft) {
    const config = normalizeConfig(draft);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
    return config;
  }
}
