import { finiteOrNull } from '../../shared/history-series.js';

const compactNumber = (value) => {
  if (Math.abs(value) >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (Math.abs(value) >= 10_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Number(value.toFixed(1)));
};

export function historyChartSvg(points, unit, id, label, from, to) {
  const values = points.map((point) => finiteOrNull(point.value)).filter((value) => value !== null);
  if (!values.length) return '';
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max(1, (maximum - minimum) * .12, Math.abs(maximum) * .03);
  const lower = unit === '%' ? 0 : unit === '°C' ? Math.max(0, Math.floor(minimum / 5) * 5 - 5) : Math.max(0, minimum - padding);
  const upper = unit === '%' ? Math.max(100, maximum) : unit === '°C' ? Math.ceil(maximum / 5) * 5 + 5 : Math.max(lower + 1, maximum + padding);
  const x = (at) => 48 + Math.max(0, Math.min(1, (at - from) / Math.max(1, to - from))) * 580;
  const y = (value) => 166 - Math.max(0, Math.min(1, (value - lower) / Math.max(1, upper - lower))) * 148;
  const segments = [];
  let segment = [];
  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  for (const point of points) {
    const value = finiteOrNull(point.value);
    if (value === null || point.breakBefore) flush();
    if (value !== null) segment.push([x(point.capturedAt).toFixed(2), y(value).toFixed(2)]);
  }
  flush();
  const grid = [0, .5, 1].map((ratio) => {
    const lineY = 166 - ratio * 148;
    return `<line class="history-grid-line" x1="48" x2="628" y1="${lineY}" y2="${lineY}"/><text class="history-axis-label" x="40" y="${lineY + 4}" text-anchor="end">${compactNumber(lower + ratio * (upper - lower))}</text>`;
  }).join('');
  const dateFormat = new Intl.DateTimeFormat('zh-CN', to - from > 48 * 3_600_000
    ? { month: '2-digit', day: '2-digit' } : { hour: '2-digit', minute: '2-digit', hour12: false });
  const ticks = [0, .5, 1].map((ratio) => `<text class="history-axis-label" x="${48 + ratio * 580}" y="190" text-anchor="${ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}">${dateFormat.format(from + ratio * (to - from))}</text>`).join('');
  const shapes = segments.map((segment) => segment.length === 1
    ? `<circle class="history-line-dot" cx="${segment[0][0]}" cy="${segment[0][1]}" r="2"/>`
    : `<polyline class="history-data-line" points="${segment.map((point) => point.join(',')).join(' ')}"/>`).join('');
  return `<svg class="history-detail-chart" data-history-id="${id}" viewBox="0 0 640 200" preserveAspectRatio="none" tabindex="0" role="img" aria-label="${label}历史曲线，可使用左右方向键查看采样值" aria-describedby="history-tooltip">
    <text class="history-axis-label history-unit-label" x="48" y="11">${unit}</text>${grid}${ticks}${shapes}
    <rect class="history-selection" x="48" y="18" width="0" height="148"/>
    <line class="history-cursor" x1="48" x2="48" y1="18" y2="166"/>
  </svg>`;
}

export function seriesSvg(samples, unit, group, from = samples[0]?.capturedAt, to = samples.at(-1)?.capturedAt) {
  const values = samples.map((point) => finiteOrNull(point.value)).filter((value) => value !== null);
  if (!values.length) return '<svg class="sparkline empty" viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M0 22 H100" /></svg>';
  let lower;
  let upper;
  if (unit === '%' || unit === '°C') {
    lower = unit === '°C' ? Math.max(0, Math.min(35, ...values)) : 0;
    upper = Math.max(100, ...values);
  } else {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const padding = Math.max(1, (maximum - minimum) * 0.12);
    lower = minimum - padding;
    upper = maximum + padding;
  }
  const range = Math.max(1, upper - lower);
  const duration = to - from;
  const segments = [];
  let segment = [];
  const flush = () => {
    if (segment.length) segments.push(segment);
    segment = [];
  };
  for (const point of samples) {
    const value = finiteOrNull(point.value);
    if (value === null || point.breakBefore) flush();
    if (value === null) continue;
    const x = duration > 0 ? Math.max(0, Math.min(100, (point.capturedAt - from) / duration * 100)) : 50;
    const y = Math.max(3, Math.min(37, 36 - (value - lower) / range * 30));
    segment.push([x.toFixed(2), y.toFixed(2)]);
  }
  flush();
  const shapes = segments.map((points) => points.length === 1
    ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r=".65" />`
    : `<polyline points="${points.map((point) => point.join(',')).join(' ')}" />`).join('');
  return `<svg class="sparkline ${group}" viewBox="0 0 100 40" preserveAspectRatio="none">${shapes}</svg>`;
}
