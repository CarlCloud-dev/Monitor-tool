import { finiteOrNull } from '../../shared/history-series.js';
import { seriesSvg } from './history-chart.js';

const { monitorApi } = window;

const state = {
  config: null,
  snapshot: null,
  saving: false,
  historySaving: false,
  installingPawnIo: false,
  pawnIoMessage: null,
  themeMenuOpen: false,
  page: 'overview',
  history: { settings: null, series: {}, totalCount: 0, from: null, to: null, loading: false, error: null }
};
const primaryMetricIds = ['cpu.load', 'cpu.temp', 'memory.load', 'gpu.load', 'gpu.temp', 'gpu.vram'];
const trendMetricIds = ['cpu.load', 'cpu.temp', 'gpu.load', 'gpu.temp'];
const historyMetricCatalog = [
  { id: 'cpu.load', label: 'CPU 利用率', unit: '%', group: 'cpu' },
  { id: 'cpu.temp', label: 'CPU 温度', unit: '°C', group: 'cpu' },
  { id: 'cpu.power', label: 'CPU 功耗', unit: 'W', group: 'cpu' },
  { id: 'cpu.fan', label: 'CPU 风扇', unit: 'RPM', group: 'cpu' },
  { id: 'memory.load', label: '内存利用率', unit: '%', group: 'memory' },
  { id: 'gpu.load', label: 'GPU 利用率', unit: '%', group: 'gpu' },
  { id: 'gpu.temp', label: 'GPU 温度', unit: '°C', group: 'gpu' },
  { id: 'gpu.power', label: 'GPU 功耗', unit: 'W', group: 'gpu' },
  { id: 'gpu.fan', label: 'GPU 风扇', unit: 'RPM', group: 'gpu' },
  { id: 'board.temp', label: '主板温度', unit: '°C', group: 'board' },
  { id: 'disk.load', label: '磁盘利用率', unit: '%', group: 'storage' },
  { id: 'network.down', label: '下载速率', unit: 'B/s', group: 'network' },
  { id: 'network.up', label: '上传速率', unit: 'B/s', group: 'network' }
];
let historyRequestId = 0;
let pendingHistorySettings = null;
let confirmedHistorySettings = null;

// 只对“数值越高越需要留意”的指标着色，避免频率、容量、网络速率等正常高值产生误报。
// 第一档为警示色，第二档为临界红色；与系统健康状态的 80/90 阈值保持一致。
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

const historyDurationLabel = (hours) => {
  const value = Number(hours);
  if (value < 24) return `${value} 小时`;
  return `${value / 24} 天`;
};

const historyTimeLabel = (timestamp, includeDate = false) => {
  if (!Number.isFinite(Number(timestamp))) return '—';
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(Number(timestamp));
};

const historyValueLabel = (value, unit) => {
  const numeric = finiteOrNull(value);
  if (numeric === null) return '—';
  if (unit === '%') return `${numeric.toFixed(0)}%`;
  if (unit === '°C') return `${numeric.toFixed(0)}°`;
  if (unit === 'W') return `${numeric.toFixed(1)} W`;
  if (unit === 'RPM') return `${numeric.toFixed(0)} RPM`;
  if (unit === 'B/s') {
    const displayUnit = state.config?.network?.unit === 'KB/s' ? 'KB/s' : 'MB/s';
    const amount = numeric / (displayUnit === 'KB/s' ? 1024 : 1024 ** 2);
    return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${displayUnit}`;
  }
  return numeric.toFixed(1);
};

const formatValue = (metric) => {
  if (!metric || metric.value === null || metric.value === undefined) return '—';
  if (metric.unit === 'B/s') return metric.detail;
  if (metric.unit === '%') return `${metric.value.toFixed(0)}%`;
  if (metric.unit === '°C') return `${metric.value.toFixed(0)}°`;
  if (metric.unit === 'GHz') return `${metric.value.toFixed(2)} GHz`;
  if (metric.unit === 'GB') return `${metric.value.toFixed(1)} GB`;
  if (metric.unit === 'RPM') return `${metric.value.toFixed(0)} RPM`;
  if (metric.unit === 'W') return `${metric.value.toFixed(1)} W`;
  return `${metric.value.toFixed(1)} ${metric.unit}`;
};

const healthDescription = (health) => ({
  checking: ['正在连接传感器', '正在建立第一份硬件快照。'],
  normal: ['运行状态良好', '已读取到温度传感器，未发现高温风险。'],
  warning: ['温度需要留意', '有传感器高于 80°C；建议检查散热与当前负载。'],
  danger: ['温度过高', '有传感器高于 90°C；请降低负载并检查散热。'],
  partial: ['基础指标正常', '系统性能数据实时可用；部分温度传感器未由设备或驱动提供。']
}[health] ?? ['正在读取系统状态', '只采集需要展示的实时指标。']);

const healthLabel = (health) => ({ checking: '检查中', normal: '良好', warning: '留意温度', danger: '高温', partial: '部分可用' }[health] ?? '检查中');

const cloneConfig = () => structuredClone(state.config);

async function saveConfig(next) {
  if (!next) return;
  state.saving = true;
  try {
    state.config = await monitorApi.saveSettings(next);
    renderSettings();
  } finally {
    state.saving = false;
  }
}

function renderSnapshot() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  if (state.pawnIoMessage && snapshot.sources.enhancedRuntime?.pawnIoInstalled === true) {
    state.pawnIoMessage = null;
    renderSettings();
  }
  const metrics = snapshot.metrics;
  const [title, copy] = healthDescription(snapshot.health);
  document.body.dataset.health = snapshot.health;
  document.querySelector('#health-title').textContent = title;
  document.querySelector('#health-copy').textContent = copy;
  document.querySelector('#health-chip').innerHTML = `<span></span><b>${healthLabel(snapshot.health)}</b>`;
  document.querySelector('#capture-time').textContent = `已更新 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(snapshot.capturedAt)}`;
  const enhancedStatus = snapshot.sources.enhanced;
  document.querySelector('#sensor-status').textContent = enhancedStatus === 'ready'
    ? '增强传感器在线'
    : snapshot.sources.temperature === 'live' ? '传感器在线' : '基础模式';
  document.querySelector('#sensor-status-detail').textContent = enhancedStatus === 'ready'
    ? 'Libre Hardware Monitor 正在提供扩展数据'
    : enhancedStatus === 'error' || enhancedStatus === 'unavailable'
      ? snapshot.sources.enhancedError || '增强传感器不可用；基础监控不受影响'
      : snapshot.sources.temperature === 'live' ? '温度与利用率数据实时更新' : '温度由硬件与驱动决定是否可用';
  document.querySelector('#cpu-device').textContent = snapshot.device.cpu;
  document.querySelector('#gpu-device').textContent = snapshot.device.gpu;

  document.querySelector('#metrics-grid').innerHTML = primaryMetricIds.map((id) => {
    const item = metrics[id];
    if (!item) return '';
    const unavailable = item.value === null ? ' is-unavailable' : '';
    const tone = metricToneClass(item);
    return `<article class="metric-card metric-${item.group}${unavailable} ${tone}">
      <div class="metric-card-top"><span class="metric-icon">${iconFor(item.icon)}</span><span class="metric-label">${item.label}</span><span class="metric-state">${item.value === null ? '不可用' : '实时'}</span></div>
      <strong class="metric-value">${formatValue(item)}</strong>
      <p>${escapeHtml(item.detail)}</p>
    </article>`;
  }).join('');

  renderTrends();
  renderMetricSelector();
}

function renderTrends() {
  const history = state.snapshot?.history ?? [];
  const metrics = state.snapshot?.metrics ?? {};
  document.querySelector('#trends-grid').innerHTML = trendMetricIds.map((id) => {
    const item = metrics[id];
    if (!item) return '';
    const samples = history.map((point) => point.values?.[id] ?? null);
    const tone = metricToneClass(item);
    return `<article class="trend-card trend-${item.group} ${tone}">
      <div><span>${item.label}</span><strong>${formatValue(item)}</strong></div>
      ${sparkline(samples, item.unit, item.group)}
    </article>`;
  }).join('');
}

function sparkline(samples, unit, group) {
  return seriesSvg(samples.map((value, index) => ({ value, capturedAt: index })), unit, group);
}

function renderHistoryPage() {
  const history = state.history;
  const settings = history.settings ?? state.config?.history ?? { enabled: true, retentionHours: 24, intervalSeconds: 10 };
  const series = history.series ?? {};
  const hasRecords = history.totalCount > 0;
  const hasChartData = hasRecords && Object.values(series).some((item) => item.stats.count > 0);
  const stateChip = document.querySelector('#history-state-chip');
  if (!stateChip) return;

  document.querySelector('#history-enabled').checked = settings.enabled;
  document.querySelector('#history-retention').value = String(settings.retentionHours);
  const selectedHistoryMetricIds = new Set(Array.isArray(settings.metricIds) && settings.metricIds.length
    ? settings.metricIds
    : historyMetricCatalog.map((metric) => metric.id));
  const historyMetricSelector = document.querySelector('#history-metric-selector');
  if (historyMetricSelector) {
    if (!historyMetricSelector.firstElementChild) historyMetricSelector.innerHTML = historyMetricCatalog.map((meta) => {
      const available = state.snapshot?.metrics?.[meta.id]?.value !== null && state.snapshot?.metrics?.[meta.id]?.value !== undefined;
      return `<label class="history-metric-row">
        <input data-history-metric="${meta.id}" type="checkbox" ${selectedHistoryMetricIds.has(meta.id) ? 'checked' : ''} />
        <span>${meta.label}</span><small>${available ? '' : '暂不可用'}</small>
      </label>`;
    }).join('');
    for (const input of historyMetricSelector.querySelectorAll('input[data-history-metric]')) {
      input.checked = selectedHistoryMetricIds.has(input.dataset.historyMetric);
      const value = state.snapshot?.metrics?.[input.dataset.historyMetric]?.value;
      input.closest('label').querySelector('small').textContent = finiteOrNull(value) === null ? '暂不可用' : '';
    }
    document.querySelector('#history-metric-count').textContent = `${selectedHistoryMetricIds.size} 项`;
  }

  stateChip.className = `history-state-chip ${settings.enabled ? (hasChartData ? '' : 'is-empty') : 'is-disabled'}`;
  stateChip.innerHTML = `<span></span><b>${settings.enabled ? (history.loading ? '读取中' : hasChartData ? '记录中' : '等待记录') : '已关闭'}</b>`;
  document.querySelector('#history-summary-status').textContent = settings.enabled ? '已开启' : '已关闭';
  document.querySelector('#history-summary-detail').textContent = settings.enabled
    ? `每 ${settings.intervalSeconds ?? 10} 秒保存一次`
    : '不会写入本地文件';
  document.querySelector('#history-summary-retention').textContent = historyDurationLabel(settings.retentionHours);
  document.querySelector('#history-summary-count').textContent = history.loading ? '读取中' : `${history.totalCount ?? 0}`;
  document.querySelector('#history-summary-range').textContent = history.from
    ? `${historyTimeLabel(history.from, true)} — ${historyTimeLabel(history.to, true)}`
    : '暂无有效记录';
  document.querySelector('#history-chart-copy').textContent = history.error
    ? history.error
    : history.loading
    ? '正在读取本地记录…'
    : hasRecords ? `${historyTimeLabel(history.from, true)} — ${historyTimeLabel(history.to, true)} · 每项最多 1200 点，保留峰值；统计基于全部记录` : '开启记录后会在这里显示本地历史曲线';
  document.querySelector('#history-storage-count').textContent = history.loading ? '读取中' : `${history.totalCount ?? 0} 个采样点`;
  document.querySelector('#history-storage-range').textContent = history.from
    ? `${historyTimeLabel(history.from, true)} — ${historyTimeLabel(history.to, true)}`
    : '暂无记录';

  const chartRoot = document.querySelector('#history-charts');
  const emptyRoot = document.querySelector('#history-empty');
  chartRoot.hidden = !hasChartData;
  emptyRoot.hidden = hasChartData;
  document.querySelector('#history-empty-title').textContent = settings.enabled ? (hasRecords ? '当前记录没有可展示的指标' : '还没有历史记录') : '历史记录已关闭';
  document.querySelector('#history-empty-copy').textContent = settings.enabled
    ? (hasRecords ? '请在右侧“记录指标”中勾选需要记录的指标，之后会从新采样开始生成曲线。' : '开启记录后，系统会每 10 秒保存一个本地采样点。')
    : '在右侧开启历史记录即可开始保存，不影响实时监控和桌面浮窗。';
  if (!hasChartData) {
    chartRoot.innerHTML = '';
    return;
  }

  chartRoot.innerHTML = historyMetricCatalog.map((meta) => {
    const item = series[meta.id];
    if (!item?.stats.count) return '';
    const { latest, minimum, maximum } = item.stats;
    return `<article class="history-chart-card history-${meta.group}">
      <header><span>${meta.label}</span><strong>${historyValueLabel(latest, meta.unit)}</strong></header>
      ${seriesSvg(item.points, meta.unit, meta.group, history.from, history.to)}
      <footer><span>最低 ${historyValueLabel(minimum, meta.unit)}</span><span>最高 ${historyValueLabel(maximum, meta.unit)}</span></footer>
    </article>`;
  }).join('');
}

async function loadHistory() {
  if (state.page !== 'history' || document.hidden || state.historySaving) return;
  monitorApi.setHistoryActive(true);
  const requestId = ++historyRequestId;
  state.history.loading = true;
  state.history.error = null;
  renderHistoryPage();
  try {
    const view = await monitorApi.getHistory();
    if (requestId !== historyRequestId) return;
    const { settings: _settings, ...data } = view;
    state.history = { ...state.history, ...data, loading: false, error: null };
  } catch (error) {
    if (requestId !== historyRequestId) return;
    state.history = { ...state.history, loading: false, error: error.message || '历史记录读取失败' };
  }
  renderHistoryPage();
}

async function saveHistorySettings() {
  const previousSettings = state.history.settings ?? state.config?.history ?? { enabled: true, retentionHours: 24, intervalSeconds: 10 };
  const next = {
    enabled: document.querySelector('#history-enabled').checked,
    retentionHours: Number(document.querySelector('#history-retention').value),
    metricIds: [...document.querySelectorAll('#history-metric-selector input[data-history-metric]:checked')].map((input) => input.dataset.historyMetric)
  };
  if (!next.metricIds.length) return;
  // Each change updates the visible draft immediately. During a save, merge
  // subsequent changes into the next draft instead of discarding the clicks.
  pendingHistorySettings = next;
  historyRequestId += 1;
  state.history.loading = false;
  state.history.settings = { ...previousSettings, ...next };
  state.history.error = null;
  renderHistoryPage();
  if (state.historySaving) return;
  state.historySaving = true;
  try {
    while (pendingHistorySettings) {
      const draft = pendingHistorySettings;
      pendingHistorySettings = null;
      try {
        const settings = await monitorApi.saveHistorySettings(draft);
        confirmedHistorySettings = settings;
        if (state.config) state.config.history = settings;
        if (!pendingHistorySettings) state.history.settings = settings;
        state.history.error = null;
      } catch (error) {
        if (!pendingHistorySettings) state.history.settings = confirmedHistorySettings ?? previousSettings;
        state.history.error = error.message || '历史设置保存失败';
      }
    }
  } finally {
    state.historySaving = false;
    renderHistoryPage();
    if (!state.history.error) void loadHistory();
  }
}

function releaseHistoryView() {
  historyRequestId += 1;
  state.history.loading = false;
  state.history.series = {};
  document.querySelector('#history-charts').innerHTML = '';
  monitorApi.setHistoryActive(false);
}

function setPage(page) {
  state.page = ['history', 'about'].includes(page) ? page : 'overview';
  document.querySelectorAll('[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === state.page));
  document.querySelector('#overview-page').hidden = state.page !== 'overview';
  document.querySelector('#history-page').hidden = state.page !== 'history';
  document.querySelector('#about-page').hidden = state.page !== 'about';
  document.querySelector('#monitor-settings-panel').hidden = state.page !== 'overview';
  document.querySelector('#history-settings-panel').hidden = state.page !== 'history';
  if (state.page === 'history') {
    renderHistoryPage();
    void loadHistory();
  } else {
    releaseHistoryView();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseHistoryView();
  else if (state.page === 'history') void loadHistory();
});

function renderSettings() {
  if (!state.config) return;
  const { overlay } = state.config;
  document.documentElement.dataset.theme = state.config.theme;
  document.querySelector('#overlay-visible').checked = overlay.visible;
  document.querySelector('#launch-at-login').checked = state.config.behavior?.launchAtLogin === true;
  const minimizeToTray = state.config.behavior?.minimizeToTray !== false;
  document.querySelector('#minimize-to-tray').checked = minimizeToTray;
  const lightweightMode = document.querySelector('#lightweight-mode');
  lightweightMode.checked = state.config.behavior?.lightweightMode !== false;
  lightweightMode.disabled = !minimizeToTray;
  document.querySelector('#lhm-enabled').checked = state.config.sensors.lhmEnabled;
  document.querySelector('#alerts-enabled').checked = state.config.alerts.enabled;
  document.querySelector('#cpu-temperature-threshold').value = state.config.alerts.cpuTemperature;
  document.querySelector('#gpu-temperature-threshold').value = state.config.alerts.gpuTemperature;
  document.querySelector('#always-on-top').checked = overlay.alwaysOnTop;
  document.querySelector('#overlay-locked').checked = overlay.locked;
  document.querySelector('#overlay-opacity').value = Math.round(overlay.opacity * 100);
  document.querySelector('#overlay-scale').value = Math.round(overlay.scale * 100);
  document.querySelector('#opacity-value').textContent = `${Math.round(overlay.opacity * 100)}%`;
  document.querySelector('#scale-value').textContent = `${Math.round(overlay.scale * 100)}%`;
  document.querySelector('#network-unit').value = state.config.network?.unit === 'KB/s' ? 'KB/s' : 'MB/s';
  document.querySelector('#refresh-label').textContent = `${(state.config.refreshMs / 1000).toFixed(1)} s`;
  const themeLabels = { system: '跟随系统', dark: '深色模式', light: '浅色模式' };
  document.querySelector('#theme-current').textContent = themeLabels[state.config.theme] ?? '跟随系统';
  document.querySelector('#theme-trigger').setAttribute('aria-expanded', String(state.themeMenuOpen));
  document.querySelector('#theme-menu').hidden = !state.themeMenuOpen;
  document.querySelectorAll('[data-theme-option]').forEach((button) => {
    const selected = button.dataset.themeOption === state.config.theme;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  const enhancedDetail = document.querySelector('#enhanced-sensor-detail');
  if (!state.config.sensors.lhmEnabled) enhancedDetail.textContent = '已关闭；基础监控仍可用，但扩展硬件数据不会读取。';
  else enhancedDetail.textContent = state.pawnIoMessage
    || state.snapshot?.sources.enhancedDetail
    || state.snapshot?.sources.enhancedError
    || '正在连接增强传感器…';
  const pawnIoInstall = document.querySelector('#pawnio-install');
  pawnIoInstall.hidden = !(
    state.config.sensors.lhmEnabled
    && state.config.sensors.lhmMode === 'elevated'
    && state.snapshot?.sources.enhancedRuntime?.pawnIoInstalled === false
  );
  pawnIoInstall.disabled = state.installingPawnIo;
  pawnIoInstall.textContent = state.installingPawnIo
    ? '正在启动驱动安装器…'
    : '安装传感器驱动（内置 · 仅一次）';
  document.querySelectorAll('#mode-picker button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.overlayMode === overlay.mode);
  });
  document.querySelectorAll('[data-top-style]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.topStyle === overlay.topStyle);
  });
  document.querySelectorAll('[data-side-position]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.sidePosition === overlay.sidePosition);
  });
  document.querySelectorAll('[data-side-columns]').forEach((button) => {
    button.classList.toggle('selected', Number(button.dataset.sideColumns) === overlay.sideColumns);
  });
  document.querySelectorAll('[data-corner-radius]').forEach((button) => {
    button.classList.toggle('selected', Number(button.dataset.cornerRadius) === overlay.cornerRadius);
  });
  document.querySelectorAll('[data-lhm-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.lhmMode === state.config.sensors.lhmMode);
  });
  document.querySelector('#top-mode-options').hidden = overlay.mode !== 'top';
  document.querySelector('#side-mode-options').hidden = overlay.mode !== 'side';
  renderMetricSelector();
}

function renderMetricSelector() {
  if (!state.config || !state.snapshot) return;
  const all = Object.values(state.snapshot.metrics);
  const selected = state.config.overlay.metrics;
  const selectedIds = new Set(selected);
  const metricsById = new Map(all.map((item) => [item.id, item]));
  // 已选项按浮窗实际顺序置顶；未选项保留传感器目录顺序，拖动后设置页和浮窗顺序一致。
  const ordered = [
    ...selected.map((id) => metricsById.get(id)).filter(Boolean),
    ...all.filter((item) => !selectedIds.has(item.id))
  ];
  document.querySelector('#selected-count').textContent = `${selected.length} 项`;
  document.querySelector('#metric-selector').innerHTML = ordered.map((item) => {
    const index = selected.indexOf(item.id);
    const checked = index >= 0;
    const availability = item.value === null
      ? `<span class="availability" title="${escapeHtml(item.detail)}">暂不可用</span>`
      : '';
    return `<div class="selector-row ${checked ? 'is-selected' : ''}" data-metric-row="${item.id}" data-metric-selected="${checked}" draggable="${checked}">
      <label><input data-metric-toggle="${item.id}" type="checkbox" ${checked ? 'checked' : ''} /><span>${iconFor(item.icon)}</span><b>${item.label}</b>${availability}</label>
      ${checked ? '<span class="drag-handle" title="拖动调整顺序" aria-hidden="true">⋮⋮</span>' : ''}
    </div>`;
  }).join('');
}

function insertMetricInSelectorOrder(selectedMetrics, metricId) {
  const selectorOrder = Object.values(state.snapshot?.metrics ?? {}).map((item) => item.id);
  const selectedMetricIds = new Set(selectedMetrics);
  const itemIndex = selectorOrder.indexOf(metricId);

  if (itemIndex < 0 || selectedMetricIds.has(metricId)) return [...selectedMetrics];

  // 插到选择器中下一个已选项之前：新项目遵循设置页的阅读顺序，
  // 同时不会重排用户已经通过上下按钮调整过的项目。
  const nextSelectedId = selectorOrder.slice(itemIndex + 1).find((id) => selectedMetricIds.has(id));
  if (!nextSelectedId) return [...selectedMetrics, metricId];

  const insertionIndex = selectedMetrics.indexOf(nextSelectedId);
  return [
    ...selectedMetrics.slice(0, insertionIndex),
    metricId,
    ...selectedMetrics.slice(insertionIndex)
  ];
}

function iconFor(icon) {
  return ({ cpu: '◌', thermometer: '∿', activity: '⌁', memory: '▦', gpu: '◇', disk: '◫', download: '↓', upload: '↑' }[icon] ?? '•');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

let draggedMetricId = null;

function clearMetricDragState() {
  draggedMetricId = null;
  document.querySelectorAll('.selector-row.is-dragging, .selector-row.is-drag-over').forEach((row) => {
    row.classList.remove('is-dragging', 'is-drag-over');
  });
}

function reorderSelectedMetrics(selectedMetrics, draggedId, targetId, insertAfter) {
  if (!draggedId || !targetId || draggedId === targetId) return selectedMetrics;
  const next = selectedMetrics.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return selectedMetrics;
  next.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

document.addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('[data-metric-row]');
  if (!row || row.dataset.metricSelected !== 'true') return;
  draggedMetricId = row.dataset.metricRow;
  row.classList.add('is-dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedMetricId);
  }
});

document.addEventListener('dragover', (event) => {
  const row = event.target.closest?.('[data-metric-row]');
  if (!draggedMetricId || !row || row.dataset.metricSelected !== 'true' || row.dataset.metricRow === draggedMetricId) return;
  event.preventDefault();
  document.querySelectorAll('.selector-row.is-drag-over').forEach((item) => item.classList.remove('is-drag-over'));
  row.classList.add('is-drag-over');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', async (event) => {
  const row = event.target.closest?.('[data-metric-row]');
  if (!draggedMetricId || !row || row.dataset.metricSelected !== 'true') return;
  event.preventDefault();
  const targetId = row.dataset.metricRow;
  const insertAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  const nextMetrics = reorderSelectedMetrics(state.config?.overlay?.metrics ?? [], draggedMetricId, targetId, insertAfter);
  clearMetricDragState();
  if (!state.config || nextMetrics === state.config.overlay.metrics || nextMetrics.join('|') === state.config.overlay.metrics.join('|')) return;
  const next = cloneConfig();
  next.overlay.metrics = nextMetrics;
  await saveConfig(next);
});

document.addEventListener('dragend', clearMetricDragState);

document.addEventListener('change', async (event) => {
  if (event.target.dataset.historyMetric) {
    if (!event.target.checked && document.querySelectorAll('#history-metric-selector input[data-history-metric]:checked').length === 0) {
      event.target.checked = true;
      return;
    }
    await saveHistorySettings();
    return;
  }
  if (event.target.id === 'history-enabled' || event.target.id === 'history-retention') {
    await saveHistorySettings();
    return;
  }
  if (!state.config || state.saving) return;
  const next = cloneConfig();
  if (event.target.id === 'overlay-visible') next.overlay.visible = event.target.checked;
  else if (event.target.id === 'launch-at-login') next.behavior.launchAtLogin = event.target.checked;
  else if (event.target.id === 'minimize-to-tray') next.behavior.minimizeToTray = event.target.checked;
  else if (event.target.id === 'lightweight-mode') next.behavior.lightweightMode = event.target.checked;
  else if (event.target.id === 'lhm-enabled') next.sensors.lhmEnabled = event.target.checked;
  else if (event.target.id === 'alerts-enabled') next.alerts.enabled = event.target.checked;
  else if (event.target.id === 'always-on-top') next.overlay.alwaysOnTop = event.target.checked;
  else if (event.target.id === 'overlay-locked') next.overlay.locked = event.target.checked;
  else if (event.target.id === 'overlay-opacity') next.overlay.opacity = Number(event.target.value) / 100;
  else if (event.target.id === 'overlay-scale') next.overlay.scale = Number(event.target.value) / 100;
  else if (event.target.id === 'network-unit') next.network.unit = event.target.value === 'KB/s' ? 'KB/s' : 'MB/s';
  else if (event.target.dataset.alertField) next.alerts[event.target.dataset.alertField] = Number(event.target.value);
  else if (event.target.dataset.metricToggle) {
    const id = event.target.dataset.metricToggle;
    next.overlay.metrics = event.target.checked
      ? insertMetricInSelectorOrder(next.overlay.metrics, id)
      : next.overlay.metrics.filter((metricId) => metricId !== id);
    if (next.overlay.metrics.length === 0) {
      event.target.checked = true;
      return;
    }
  } else return;
  await saveConfig(next);
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'overlay-opacity') document.querySelector('#opacity-value').textContent = `${event.target.value}%`;
  if (event.target.id === 'overlay-scale') document.querySelector('#scale-value').textContent = `${event.target.value}%`;
});

document.addEventListener('click', async (event) => {
  const pageTarget = event.target.closest?.('[data-page]');
  if (pageTarget) {
    setPage(pageTarget.dataset.page);
    return;
  }
  if (event.target.id === 'history-refresh') {
    await loadHistory();
    return;
  }
  if (event.target.id === 'history-clear') {
    if (!window.confirm('确定清空全部历史记录吗？此操作不可撤销。')) return;
    historyRequestId += 1;
    try {
      await monitorApi.clearHistory();
      state.history = { ...state.history, series: {}, totalCount: 0, from: null, to: null, loading: false, error: null };
      await loadHistory();
    } catch (error) {
      state.history.error = error.message || '历史记录清空失败';
      renderHistoryPage();
    }
    return;
  }
  if (!state.config || state.saving) return;
  const themeOption = event.target.closest('[data-theme-option]')?.dataset.themeOption;
  if (themeOption) {
    state.themeMenuOpen = false;
    const next = cloneConfig();
    next.theme = themeOption;
    await saveConfig(next);
    return;
  }
  if (event.target.closest('#theme-trigger')) {
    state.themeMenuOpen = !state.themeMenuOpen;
    renderSettings();
    return;
  }
  if (state.themeMenuOpen && !event.target.closest('#theme-picker')) {
    state.themeMenuOpen = false;
    renderSettings();
  }
  if (event.target.id === 'pawnio-install') {
    state.installingPawnIo = true;
    state.pawnIoMessage = '正在请求 Windows 授权以安装内置传感器驱动…';
    renderSettings();
    try {
      const result = await monitorApi.installPawnIo();
      state.pawnIoMessage = result?.message || '安装已完成，正在重新连接硬件传感器…';
    } catch (error) {
      state.pawnIoMessage = `驱动安装未完成：${error.message || '请在 UAC 中确认后重试。'}`;
    } finally {
      state.installingPawnIo = false;
      renderSettings();
    }
    return;
  }
  const cornerRadius = Number(event.target.dataset.cornerRadius);
  if ([0, 8, 18].includes(cornerRadius)) {
    const next = cloneConfig();
    next.overlay.cornerRadius = cornerRadius;
    await saveConfig(next);
    return;
  }
  const lhmMode = event.target.dataset.lhmMode;
  if (lhmMode === 'standard' || lhmMode === 'elevated') {
    const next = cloneConfig();
    next.sensors.lhmMode = lhmMode;
    await saveConfig(next);
    return;
  }
  const overlayMode = event.target.dataset.overlayMode;
  if (overlayMode) {
    const next = cloneConfig();
    next.overlay.mode = overlayMode;
    next.overlay.bounds = null;
    await saveConfig(next);
    return;
  }
  const topStyle = event.target.dataset.topStyle;
  if (topStyle) {
    const next = cloneConfig();
    next.overlay.mode = 'top';
    next.overlay.topStyle = topStyle;
    next.overlay.bounds = null;
    await saveConfig(next);
    return;
  }
  const sidePosition = event.target.dataset.sidePosition;
  if (sidePosition) {
    const next = cloneConfig();
    next.overlay.mode = 'side';
    next.overlay.sidePosition = sidePosition;
    next.overlay.bounds = null;
    await saveConfig(next);
    return;
  }
  const sideColumns = Number(event.target.dataset.sideColumns);
  if ([1, 2].includes(sideColumns)) {
    const next = cloneConfig();
    next.overlay.mode = 'side';
    next.overlay.sideColumns = sideColumns;
    next.overlay.bounds = null;
    await saveConfig(next);
    return;
  }
  const metricId = event.target.dataset.moveMetric;
  if (metricId) {
    const next = cloneConfig();
    const oldIndex = next.overlay.metrics.indexOf(metricId);
    const newIndex = oldIndex + Number(event.target.dataset.direction);
    if (newIndex < 0 || newIndex >= next.overlay.metrics.length) return;
    [next.overlay.metrics[oldIndex], next.overlay.metrics[newIndex]] = [next.overlay.metrics[newIndex], next.overlay.metrics[oldIndex]];
    await saveConfig(next);
    return;
  }
  if (event.target.id === 'reset-position') {
    state.config = await monitorApi.resetOverlayPosition();
    renderSettings();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.themeMenuOpen) return;
  state.themeMenuOpen = false;
  renderSettings();
  document.querySelector('#theme-trigger').focus();
});

async function boot() {
  const [config, snapshot] = await Promise.all([monitorApi.getSettings(), monitorApi.getSnapshot()]);
  state.config = config;
  state.snapshot = snapshot;
  state.history.settings = config.history;
  confirmedHistorySettings = config.history;
  renderSettings();
  renderSnapshot();
  monitorApi.onMonitorUpdate((snapshotUpdate) => {
    state.snapshot = snapshotUpdate;
    renderSnapshot();
  });
  monitorApi.onSettingsChanged((settingsUpdate) => {
    state.config = settingsUpdate;
    renderSettings();
  });
  monitorApi.onHistoryChanged(() => {
    if (state.page === 'history' && !state.history.loading) void loadHistory();
  });
  monitorApi.onHistorySettingsChanged((settingsUpdate) => {
    // Our queued draft is newer than the acknowledgement for an earlier save.
    if (state.historySaving) return;
    historyRequestId += 1;
    state.history.loading = false;
    confirmedHistorySettings = settingsUpdate;
    state.history.settings = settingsUpdate;
    if (state.config) state.config.history = settingsUpdate;
    if (state.page === 'history') {
      renderHistoryPage();
      void loadHistory();
    }
  });
}

boot();
