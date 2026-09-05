const { monitorApi } = window;
const state = { config: null, snapshot: null };
let lastReportedSize = null;
let renderedLayoutKey = '';
let renderedLayoutIsMinimal = false;
let metricNodes = new Map();
let groupNodes = new Map();
let resizeFramePending = false;

const iconFor = (icon) => ({ cpu: '◌', thermometer: '∿', activity: '⌁', memory: '▦', gpu: '◇', disk: '◫', download: '↓', upload: '↑' }[icon] ?? '•');
const groupLabel = (group) => ({ cpu: 'CPU', memory: '内存', gpu: 'GPU', board: '主板', storage: '磁盘', network: '网络' }[group] ?? '状态');

// 只对高负载、高温或高功耗/高转速指标着色；第一档警示，第二档临界红色。
const toneThresholds = {
  'cpu.load': [80, 90],
  'cpu.temp': [80, 90],
  'cpu.power': [120, 180],
  'cpu.fan': [1800, 2400],
  'memory.load': [80, 90],
  'gpu.load': [80, 90],
  'gpu.temp': [80, 90],
  'gpu.vram': [85, 95],
  'gpu.power': [180, 250],
  'gpu.fan': [1800, 2400],
  'board.temp': [70, 85],
  'disk.load': [80, 95]
};

const metricToneClass = (metric) => {
  const thresholds = toneThresholds[metric?.id];
  const value = Number(metric?.value);
  if (!thresholds || !Number.isFinite(value)) return '';
  if (value >= thresholds[1]) return 'is-critical';
  if (value >= thresholds[0]) return 'is-warning';
  return '';
};

const groupToneClass = (items) => {
  if (items.some((item) => metricToneClass(item) === 'is-critical')) return 'is-critical';
  if (items.some((item) => metricToneClass(item) === 'is-warning')) return 'is-warning';
  return '';
};

const formatValue = (metric) => {
  if (!metric || metric.value === null || metric.value === undefined) return '—';
  if (metric.unit === 'B/s') return metric.detail;
  if (metric.unit === '%') return `${metric.value.toFixed(0)}%`;
  if (metric.unit === '°C') return `${metric.value.toFixed(0)}°C`;
  if (metric.unit === 'GHz') return `${metric.value.toFixed(2)} GHz`;
  if (metric.unit === 'GB') return `${metric.value.toFixed(1)} GB`;
  return `${metric.value.toFixed(1)} ${metric.unit}`;
};

const groupedMetrics = (metrics) => {
  const groups = new Map();
  for (const metric of metrics) {
    const existing = groups.get(metric.group) ?? [];
    existing.push(metric);
    groups.set(metric.group, existing);
  }
  return [...groups.entries()];
};

const renderMinimalMetrics = (metrics) => groupedMetrics(metrics).map(([group, items]) => `
  <article class="overlay-metric metric-${group} ${items.every((item) => item.value === null) ? 'is-unavailable' : ''} ${groupToneClass(items)}" data-metric-group="${group}">
    <span class="overlay-label">${groupLabel(group)}</span>
    <span class="inline-values">${items.map((item) => `<strong class="inline-value ${metricToneClass(item)}" data-metric-id="${item.id}" title="${item.label}">${formatValue(item)}</strong>`).join('')}</span>
  </article>`).join('');

const renderDetailedMetrics = (metrics) => metrics.map((item) => `
  <article class="overlay-metric metric-${item.group} ${item.value === null ? 'is-unavailable' : ''} ${metricToneClass(item)}" data-metric-group="${item.group}">
    <span class="overlay-icon">${iconFor(item.icon)}</span>
    <span class="overlay-label">${item.label}</span>
    <strong data-metric-id="${item.id}">${formatValue(item)}</strong>
  </article>`).join('');

const layoutKeyFor = (overlay) => [
  overlay.mode,
  overlay.topStyle,
  overlay.sidePosition,
  overlay.sideColumns,
  overlay.metrics.join(',')
].join('|');

const rebuildLayout = (root, overlay, selectedMetrics) => {
  const isMinimal = overlay.mode === 'top' && overlay.topStyle === 'minimal';
  const metricsMarkup = isMinimal
    ? renderMinimalMetrics(selectedMetrics)
    : renderDetailedMetrics(selectedMetrics);
  root.innerHTML = '<section class="overlay-shell' + (overlay.locked ? ' is-locked' : '') + '">' +
    '<div class="overlay-metrics">' + metricsMarkup + '</div></section>';
  metricNodes = new Map([...root.querySelectorAll('[data-metric-id]')].map((node) => [node.dataset.metricId, node]));
  groupNodes = new Map();
  for (const node of root.querySelectorAll('[data-metric-group]')) {
    const group = groupNodes.get(node.dataset.metricGroup) ?? [];
    group.push(node);
    groupNodes.set(node.dataset.metricGroup, group);
  }
  renderedLayoutKey = layoutKeyFor(overlay);
  renderedLayoutIsMinimal = isMinimal;
};

const toggleToneClasses = (node, tone) => {
  node.classList.toggle('is-warning', tone === 'is-warning');
  node.classList.toggle('is-critical', tone === 'is-critical');
};

const updateMetricNodes = (selectedMetrics) => {
  let valueChanged = false;
  for (const metric of selectedMetrics) {
    const node = metricNodes.get(metric.id);
    if (!node) continue;
    const value = formatValue(metric);
    if (node.textContent !== value) {
      node.textContent = value;
      valueChanged = true;
    }
    node.title = metric.label;
    const tone = metricToneClass(metric);
    toggleToneClasses(node, tone);
    if (!renderedLayoutIsMinimal) {
      const article = node.closest('.overlay-metric');
      if (article) {
        article.classList.toggle('is-unavailable', metric.value === null);
        toggleToneClasses(article, tone);
      }
    }
  }
  if (renderedLayoutIsMinimal) {
    for (const [group, items] of groupedMetrics(selectedMetrics)) {
      const tone = groupToneClass(items);
      for (const node of groupNodes.get(group) ?? []) {
        node.classList.toggle('is-unavailable', items.every((item) => item.value === null));
        toggleToneClasses(node, tone);
      }
    }
  }
  return valueChanged;
};

const scheduleResize = (root, overlay, shouldResize) => {
  if (!shouldResize || resizeFramePending) return;
  resizeFramePending = true;
  requestAnimationFrame(() => {
    resizeFramePending = false;
    const shell = root.querySelector('.overlay-shell');
    if (!shell) return;
    const bounds = shell.getBoundingClientRect();
    // 顶部浮窗两侧各留 1px 透明安全边，避免圆角抗锯齿正好贴在窗口边界时被裁切。
    const edgeGutter = overlay.mode === 'top' ? 2 : 0;
    const size = {
      width: Math.ceil(bounds.width) + edgeGutter,
      height: Math.ceil(bounds.height) + edgeGutter
    };
    const contentIsStale = Math.abs(window.innerWidth - size.width) > 1 || Math.abs(window.innerHeight - size.height) > 1;
    if (!lastReportedSize || contentIsStale || Math.abs(lastReportedSize.width - size.width) > 1 || Math.abs(lastReportedSize.height - size.height) > 1) {
      lastReportedSize = size;
      monitorApi.resizeOverlay(size);
    }
  });
};

function render() {
  if (!state.config || !state.snapshot) return;
  const { overlay } = state.config;
  const selectedMetrics = overlay.metrics.map((id) => state.snapshot.metrics[id]).filter(Boolean);
  const root = document.querySelector('#overlay-root');
  const modeClass = overlay.mode === 'side'
    ? 'mode-side side-' + overlay.sidePosition + ' side-columns-' + overlay.sideColumns
    : 'mode-top top-' + overlay.topStyle;
  root.className = modeClass;
  root.style.setProperty('--scale', overlay.scale);
  root.style.setProperty('--corner-radius', String(overlay.cornerRadius * overlay.scale) + 'px');
  root.style.setProperty('--corner-content-inset', String(Math.ceil(overlay.cornerRadius * overlay.scale * 0.6)) + 'px');
  root.style.setProperty('--top-columns', String(Math.min(Math.max(selectedMetrics.length, 1), 12)));
  root.dataset.theme = state.config.theme;
  root.dataset.health = state.snapshot.health;
  const layoutChanged = renderedLayoutKey !== layoutKeyFor(overlay);
  if (layoutChanged) rebuildLayout(root, overlay, selectedMetrics);
  const valueChanged = layoutChanged ? false : updateMetricNodes(selectedMetrics);
  const shell = root.querySelector('.overlay-shell');
  shell?.classList.toggle('is-locked', overlay.locked);
  scheduleResize(root, overlay, layoutChanged || valueChanged || !lastReportedSize);
}

async function boot() {
  const [config, snapshot] = await Promise.all([monitorApi.getSettings(), monitorApi.getSnapshot()]);
  state.config = config;
  state.snapshot = snapshot;
  render();
  monitorApi.onMonitorUpdate((snapshotUpdate) => {
    state.snapshot = snapshotUpdate;
    render();
  });
  monitorApi.onSettingsChanged((configUpdate) => {
    state.config = configUpdate;
    lastReportedSize = null;
    render();
  });
}

boot();
