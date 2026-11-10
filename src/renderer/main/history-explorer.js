const HOUR = 3_600_000;
const pad = (value) => String(value).padStart(2, '0');
const dateInput = (at) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const timeInput = (at) => {
  const date = new Date(at);
  return `${dateInput(at)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const timeLabel = (at, seconds = false) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false
}).format(at);

export class HistoryExplorer {
  constructor(catalog, onChange) {
    this.catalog = catalog;
    this.onChange = onChange;
    this.selection = { type: 'recent', hours: 24 };
    this.metric = 'all';
    this.stack = [];
    this.view = {};
    this.drag = null;
    this.inspected = new Map();
    this.root = document.querySelector('#history-explorer');
    this.charts = document.querySelector('#history-charts');
    this.tooltip = document.querySelector('#history-tooltip');
    document.querySelector('#history-calendar-date').value = dateInput(Date.now());
    document.querySelector('#history-calendar-hour').innerHTML = Array.from({ length: 24 }, (_, hour) => `<option value="${hour}">${pad(hour)}:00</option>`).join('');
    document.querySelector('#history-calendar-hour').value = String(new Date().getHours());
    const metricSelect = document.querySelector('#history-view-metric');
    metricSelect.innerHTML = '<option value="all">全部有记录的指标</option>' + catalog.map((meta) => `<option value="${meta.id}">${meta.label}</option>`).join('');
    this.updateInputs();
    this.root.addEventListener('click', (event) => this.handleClick(event));
    metricSelect.addEventListener('change', () => { this.metric = metricSelect.value; this.onChange(); });
    document.querySelector('#history-calendar-unit').addEventListener('change', (event) => {
      document.querySelector('#history-calendar-hour-label').hidden = event.target.value !== 'hour';
    });
    this.charts.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.charts.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.charts.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.charts.addEventListener('pointercancel', () => this.clearDrag());
    this.charts.addEventListener('pointerleave', () => { if (!this.drag) this.hideInspection(); });
    this.charts.addEventListener('keydown', (event) => this.keyDown(event));
    this.charts.addEventListener('focusout', () => this.hideInspection());
    window.addEventListener('scroll', () => this.hideInspection(), true);
  }

  isLive() { return this.selection.type === 'recent' && this.selection.hours <= 24; }

  refresh() {
    if (this.selection.type === 'all' || this.selection.type === 'recent') this.selection.to = Date.now();
  }

  range() {
    const selected = this.selection;
    if (selected.type === 'recent') {
      const to = this.isLive() ? Date.now() : selected.to;
      return { from: to - selected.hours * HOUR, to };
    }
    if (selected.type === 'all') return { from: 0, to: selected.to };
    if (selected.type === 'custom') return { from: selected.from, to: selected.to };
    const start = new Date(selected.date + 'T00:00:00');
    if (selected.unit === 'hour') start.setHours(selected.hour);
    if (selected.unit === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    const end = new Date(start);
    if (selected.unit === 'hour') end.setHours(end.getHours() + 1);
    else end.setDate(end.getDate() + (selected.unit === 'week' ? 7 : 1));
    return { from: start.getTime(), to: end.getTime() };
  }

  query() {
    return { ...this.range(), ...(this.metric === 'all' ? {} : { metricIds: [this.metric] }) };
  }

  message(value = '') {
    const node = document.querySelector('#history-view-error');
    node.textContent = value;
    node.hidden = !value;
  }

  updateInputs() {
    const range = this.range();
    const from = range.from || Date.now() - 24 * HOUR;
    document.querySelector('#history-custom-from').value = timeInput(from);
    document.querySelector('#history-custom-to').value = timeInput(Math.min(Date.now(), range.to));
    if (this.selection.type === 'calendar') {
      document.querySelector('#history-calendar-date').value = this.selection.date;
      document.querySelector('#history-calendar-unit').value = this.selection.unit;
      document.querySelector('#history-calendar-hour').value = String(this.selection.hour ?? 0);
      document.querySelector('#history-calendar-hour-label').hidden = this.selection.unit !== 'hour';
    }
  }

  select(next, zoom = false) {
    if (zoom) this.stack = [...this.stack.slice(-19), { ...this.selection }];
    else this.stack = [];
    this.selection = next;
    this.view = {};
    this.message();
    this.hideInspection();
    this.updateInputs();
    this.onChange();
  }

  handleClick(event) {
    const preset = event.target.closest('[data-history-hours]');
    if (preset) {
      const hours = Number(preset.dataset.historyHours);
      this.select(hours ? { type: 'recent', hours, to: Date.now() } : { type: 'all', to: Date.now() });
      return;
    }
    const action = event.target.closest('[data-history-action]')?.dataset.historyAction;
    if (!action) return;
    if (action === 'latest') { this.select({ type: 'recent', hours: 24 }); return; }
    if (action === 'back') {
      const previous = this.stack.pop();
      if (!previous) return;
      this.selection = previous;
      this.view = {};
      this.updateInputs();
      this.message();
      this.onChange();
      return;
    }
    if (action === 'calendar') {
      const date = document.querySelector('#history-calendar-date');
      if (!date.value || !date.reportValidity()) return;
      const unit = document.querySelector('#history-calendar-unit').value;
      this.select({ type: 'calendar', date: date.value, unit, hour: Number(document.querySelector('#history-calendar-hour').value) });
      return;
    }
    if (action === 'custom') {
      const from = new Date(document.querySelector('#history-custom-from').value).getTime();
      const to = new Date(document.querySelector('#history-custom-to').value).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 60_000) { this.message('请选择有效时间，结束至少晚于开始 1 分钟'); return; }
      this.select({ type: 'custom', from, to });
      return;
    }
    if (action === 'previous' || action === 'next') {
      const direction = action === 'previous' ? -1 : 1;
      if (this.selection.type === 'calendar') {
        const start = new Date(this.range().from);
        if (this.selection.unit === 'hour') start.setHours(start.getHours() + direction);
        else start.setDate(start.getDate() + direction * (this.selection.unit === 'week' ? 7 : 1));
        this.select({ ...this.selection, date: dateInput(start), hour: start.getHours() });
      } else {
        const range = !this.view.loading && this.view.range ? this.view.range : this.range();
        const step = range.to - range.from;
        const to = Math.min(Date.now(), range.to + direction * step);
        this.select({ type: 'custom', from: to - step, to });
      }
    }
  }

  sync(view) {
    this.clearDrag();
    this.hideInspection();
    this.view = view;
    const range = !view.loading && view.range ? view.range : this.range();
    document.querySelector('#history-view-range').textContent = range.from ? `${timeLabel(range.from)} — ${timeLabel(Math.min(range.to, Date.now()))}` : '全部保留记录';
    document.querySelector('#history-view-mode').textContent = this.isLive() ? '实时跟随 · 每 10 秒更新' : '历史快照 · 点击刷新更新';
    for (const button of this.root.querySelectorAll('[data-history-hours]')) {
      const hours = Number(button.dataset.historyHours);
      const selected = this.selection.type === 'recent' && this.selection.hours === hours || !hours && this.selection.type === 'all';
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this.root.querySelector('[data-history-action="back"]').disabled = !this.stack.length;
    const cutoff = Date.now() - (view.settings?.retentionHours ?? 168) * HOUR;
    this.root.querySelector('[data-history-action="previous"]').disabled = this.selection.type === 'all' || range.from <= cutoff;
    this.root.querySelector('[data-history-action="next"]').disabled = this.selection.type === 'all' || range.to >= Date.now() - 1000;
    document.querySelector('#history-calendar-date').max = dateInput(Date.now());
    document.querySelector('#history-calendar-date').min = dateInput(cutoff);
    this.charts.classList.toggle('is-focused', this.metric !== 'all');
    this.charts.classList.toggle('is-loading', view.loading);
    this.charts.setAttribute('aria-busy', String(view.loading));
  }

  ratio(svg, clientX) {
    const bounds = svg.getBoundingClientRect();
    return Math.min(1, Math.max(0, ((clientX - bounds.left) / bounds.width * 640 - 48) / 580));
  }

  hideInspection() {
    this.tooltip.hidden = true;
    this.charts.querySelectorAll('.history-cursor').forEach((line) => { line.classList.remove('is-visible'); });
  }

  showPoint(svg, index, clientX, clientY, keyboard = false) {
    const id = svg.dataset.historyId;
    const points = this.view.series?.[id]?.points ?? [];
    const point = points[index];
    if (!point) return;
    const meta = this.catalog.find((entry) => entry.id === id);
    const range = this.view.range;
    if (!meta || !range) return;
    this.inspected.set(id, index);
    const x = 48 + (point.capturedAt - range.from) / Math.max(1, range.to - range.from) * 580;
    const line = svg.querySelector('.history-cursor');
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.classList.add('is-visible');
    this.tooltip.textContent = `${timeLabel(point.capturedAt, true)}\n${meta.label}：${point.value === null ? '无有效读数' : Number(point.value.toFixed(2)) + ' ' + meta.unit}`;
    this.tooltip.setAttribute('aria-live', keyboard ? 'polite' : 'off');
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - this.tooltip.offsetWidth - 12, clientX + 12))}px`;
    this.tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - this.tooltip.offsetHeight - 12, clientY + 18))}px`;
  }

  pointerMove(event) {
    if (this.drag) {
      const ratio = this.ratio(this.drag.svg, event.clientX);
      const selection = this.drag.svg.querySelector('.history-selection');
      selection.setAttribute('x', 48 + Math.min(this.drag.ratio, ratio) * 580);
      selection.setAttribute('width', Math.abs(this.drag.ratio - ratio) * 580);
      selection.classList.add('is-visible');
      return;
    }
    const svg = event.target.closest('.history-detail-chart');
    if (!svg || !this.view.range) { this.hideInspection(); return; }
    const points = this.view.series?.[svg.dataset.historyId]?.points ?? [];
    if (!points.length) return;
    const at = this.view.range.from + this.ratio(svg, event.clientX) * (this.view.range.to - this.view.range.from);
    let left = 0;
    let right = points.length - 1;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (points[middle].capturedAt < at) left = middle + 1;
      else right = middle;
    }
    const index = left > 0 && Math.abs(points[left - 1].capturedAt - at) < Math.abs(points[left].capturedAt - at) ? left - 1 : left;
    this.showPoint(svg, index, event.clientX, event.clientY);
    const before = points[left - 1];
    const after = points[left];
    if (before && after && at > before.capturedAt && at < after.capturedAt
      && (after.breakBefore || before.value === null || after.value === null)) {
      this.tooltip.textContent = `${timeLabel(at, true)}\n此区间缺测或未记录，放大可细看边界`;
      const x = 48 + this.ratio(svg, event.clientX) * 580;
      const line = svg.querySelector('.history-cursor');
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
    }
  }

  pointerDown(event) {
    const svg = event.target.closest('.history-detail-chart');
    if (!svg || event.button !== 0 || !this.view.range || this.view.loading) return;
    this.hideInspection();
    this.drag = { svg, ratio: this.ratio(svg, event.clientX), range: { ...this.view.range }, pointerId: event.pointerId, startX: event.clientX };
    svg.setPointerCapture(event.pointerId);
  }

  clearDrag() {
    if (!this.drag) return;
    const { svg, pointerId } = this.drag;
    this.drag = null;
    svg.querySelector('.history-selection').classList.remove('is-visible');
    if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  }

  pointerUp(event) {
    if (!this.drag) return;
    const drag = this.drag;
    const end = this.ratio(drag.svg, event.clientX);
    this.clearDrag();
    const duration = drag.range.to - drag.range.from;
    if (Math.abs(event.clientX - drag.startX) < 8) { this.pointerMove(event); return; }
    const from = Math.round(drag.range.from + Math.min(drag.ratio, end) * duration);
    const to = Math.round(drag.range.from + Math.max(drag.ratio, end) * duration);
    if (to - from < 60_000) { this.message('框选区间至少需要 1 分钟'); return; }
    this.select({ type: 'custom', from, to }, true);
  }

  keyDown(event) {
    const svg = event.target.closest('.history-detail-chart');
    if (!svg) return;
    if (event.key === 'Escape') { this.hideInspection(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const points = this.view.series?.[svg.dataset.historyId]?.points ?? [];
    if (!points.length) return;
    const previous = this.inspected.get(svg.dataset.historyId) ?? 0;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.min(points.length - 1, Math.max(0, previous + (event.key === 'ArrowRight' ? 1 : -1)));
    const bounds = svg.getBoundingClientRect();
    this.showPoint(svg, index, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, true);
  }
}
