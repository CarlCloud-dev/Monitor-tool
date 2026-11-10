const labels = { cpu: 'CPU', memory: '内存', gpu: 'GPU', board: '主板', storage: '磁盘', network: '网络' };
const colors = { cpu: '#a3bd85', memory: '#c4acde', gpu: '#82bcce', board: '#dfba79', storage: '#bcabdc', network: '#9ac4a5' };
const lightColors = { cpu: '#3e6728', memory: '#765398', gpu: '#246b82', board: '#93651e', storage: '#675397', network: '#316e46' };
const thresholds = { 'cpu.load': [80,90], 'cpu.temp': [80,90], 'cpu.power': [120,180], 'cpu.fan': [1800,2400], 'memory.load': [80,90], 'memory.temp': [70,85], 'gpu.load': [80,90], 'gpu.temp': [80,90], 'gpu.vram': [85,95], 'gpu.power': [180,250], 'gpu.fan': [1800,2400], 'board.temp': [70,85], 'disk.load': [80,95] };
export function formatTaskbarValue(metric) {
  if (metric?.value == null || !Number.isFinite(metric.value)) return '—';
  if (metric.unit === 'B/s') return metric.detail ?? '—';
  if (['%', '°C'].includes(metric.unit)) return `${metric.value.toFixed(0)}${metric.unit}`;
  if (metric.unit === 'GHz') return `${metric.value.toFixed(2)} GHz`;
  return `${metric.value.toFixed(1)} ${metric.unit}`;
}
export function taskbarContent(config, snapshot, systemDark) {
  const dark = config.theme === 'system' ? systemDark : config.theme !== 'light';
  const runs = [], groups = new Map();
  for (const id of config.overlay.metrics) {
    const metric = snapshot?.metrics?.[id];
    const group = metric?.group ?? (id.startsWith('disk.') ? 'storage' : id.split('.')[0]);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(metric);
  }
  const normal = dark ? '#e8edf3' : '#26323d';
  for (const [group, metrics] of groups) {
    if (runs.length) runs.push({ kind: 'groupSeparator', text: '', gapBefore: 12, gapAfter: 12, color: dark ? '#525d69' : '#c1cad3', bold: false });
    runs.push({ kind: 'label', text: labels[group] ?? '状态', gapAfter: 7, color: (dark ? colors : lightColors)[group] ?? normal, bold: true });
    metrics.forEach((metric, index) => {
      if (index) runs.push({ kind: 'itemSeparator', text: '·', gapBefore: 6, gapAfter: 6, color: dark ? '#7d8793' : '#98a3ae', bold: false });
      const levels = thresholds[metric?.id];
      const color = metric?.value != null && levels && metric.value >= levels[1] ? (dark ? '#ff7777' : '#bd2d32')
        : metric?.value != null && levels && metric.value >= levels[0] ? (dark ? '#e8b465' : '#986317') : normal;
      runs.push({ kind: 'value', text: formatTaskbarValue(metric), color, bold: false });
    });
  }
  return { kind: 'content', runs, dark };
}
