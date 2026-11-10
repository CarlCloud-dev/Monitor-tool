// Missing sensor values are not zero. Accept old numeric strings, but not blanks/booleans.
export const finiteOrNull = (value) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

// Bounded-memory time buckets. Segment identities survive downsampling so an
// omitted null value or shutdown gap can never become an uninterrupted line.
const copySample = (target, capturedAt, value, segment, sequence) => {
  const point = target ?? {};
  point.capturedAt = capturedAt;
  point.value = value;
  point.segment = segment;
  point.sequence = sequence;
  return point;
};

export function createMetricSeriesAccumulator(from, to, maxPoints = 1200, gapMs = 20_000) {
  const bucketCount = Math.max(1, Math.floor(maxPoints / 5));
  const buckets = new Map();
  const stats = { count: 0, minimum: null, maximum: null, latest: null, mean: null };
  let sum = 0;
  let latestAt = -Infinity;
  let previousAt = null;
  let previousMissing = false;
  let segment = 0;
  let sequence = 0;
  return {
    add(capturedAt, rawValue) {
      const value = finiteOrNull(rawValue);
      if (previousAt !== null && (capturedAt < previousAt || capturedAt - previousAt > gapMs || previousMissing || value === null)) segment++;
      const index = sequence++;
      previousAt = capturedAt;
      previousMissing = value === null;
      if (capturedAt >= latestAt) { latestAt = capturedAt; stats.latest = value; }
      if (value !== null) {
        stats.count++;
        sum += value;
        stats.minimum = stats.minimum === null ? value : Math.min(stats.minimum, value);
        stats.maximum = stats.maximum === null ? value : Math.max(stats.maximum, value);
      }
      const key = Math.min(bucketCount - 1, Math.max(0, Math.floor((capturedAt - from) / Math.max(1, to - from) * bucketCount)));
      const bucket = buckets.get(key) ?? { first: null, last: null, minimum: null, maximum: null, missing: null };
      if (!bucket.first || capturedAt < bucket.first.capturedAt) bucket.first = copySample(bucket.first, capturedAt, value, segment, index);
      if (!bucket.last || capturedAt >= bucket.last.capturedAt) bucket.last = copySample(bucket.last, capturedAt, value, segment, index);
      if (value === null) {
        if (!bucket.missing || capturedAt < bucket.missing.capturedAt) bucket.missing = copySample(bucket.missing, capturedAt, value, segment, index);
      } else {
        if (!bucket.minimum || value < bucket.minimum.value) bucket.minimum = copySample(bucket.minimum, capturedAt, value, segment, index);
        if (!bucket.maximum || value > bucket.maximum.value) bucket.maximum = copySample(bucket.maximum, capturedAt, value, segment, index);
      }
      buckets.set(key, bucket);
    },
    finish() {
      const selected = new Map();
      for (const bucket of buckets.values()) {
        for (const point of Object.values(bucket)) if (point) selected.set(point.sequence, point);
      }
      let previousSegment = null;
      const points = [...selected.values()].sort((left, right) => left.capturedAt - right.capturedAt || left.sequence - right.sequence).map((point) => {
        const breakBefore = point.value === null || previousSegment !== point.segment;
        previousSegment = point.value === null ? null : point.segment;
        return { capturedAt: point.capturedAt, value: point.value, breakBefore };
      });
      return { stats: { ...stats, mean: stats.count ? sum / stats.count : null }, points };
    }
  };
}

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
