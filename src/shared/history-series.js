// Missing sensor values are not zero. Accept old numeric strings, but not blanks/booleans.
export const finiteOrNull = (value) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

// Keep first/last and per-bucket extrema, plus an unavailable sample if present.
// Each point carries a gap flag based on ALL intervening raw records, not just
// selected points, so downsampling cannot draw a line across missing data.
export function buildMetricSeries(records, id, maxPoints = 1200, gapMs = 20_000) {
  const selected = new Set();
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 5));
  const bucketSize = Math.max(1, Math.ceil(Math.max(0, records.length - 2) / bucketCount));
  const buckets = new Map();
  const stats = { count: 0, minimum: null, maximum: null, latest: null };
  for (let index = 0; index < records.length; index += 1) {
    const value = finiteOrNull(records[index].values?.[id]);
    stats.latest = value;
    if (value !== null) {
      stats.count += 1;
      stats.minimum = stats.minimum === null ? value : Math.min(stats.minimum, value);
      stats.maximum = stats.maximum === null ? value : Math.max(stats.maximum, value);
    }
    if (records.length <= maxPoints || index === 0 || index === records.length - 1) {
      selected.add(index);
      continue;
    }
    const key = Math.floor((index - 1) / bucketSize);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { first: index, last: index, minimum: null, maximum: null, missing: null };
      buckets.set(key, bucket);
    }
    bucket.last = index;
    if (value === null) {
      bucket.missing ??= index;
    } else {
      if (bucket.minimum === null || value < finiteOrNull(records[bucket.minimum].values?.[id])) bucket.minimum = index;
      if (bucket.maximum === null || value > finiteOrNull(records[bucket.maximum].values?.[id])) bucket.maximum = index;
    }
  }
  for (const bucket of buckets.values()) {
    for (const index of Object.values(bucket)) if (index !== null) selected.add(index);
  }
  const points = [];
  let breakBefore = true;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const value = finiteOrNull(record.values?.[id]);
    if (index && record.capturedAt - records[index - 1].capturedAt > gapMs) breakBefore = true;
    if (value === null) breakBefore = true;
    if (selected.has(index)) {
      points.push({ capturedAt: record.capturedAt, value, breakBefore });
      breakBefore = value === null;
    }
  }
  return { stats, points };
}
