import { finiteOrNull } from '../../shared/history-series.js';

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
