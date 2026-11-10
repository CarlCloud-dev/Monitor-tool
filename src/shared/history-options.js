export const DEFAULT_HISTORY_RETENTION_HOURS = 7 * 24;
export const HISTORY_RETENTION_OPTIONS = Object.freeze([7 * 24, 30 * 24, 90 * 24, 180 * 24]);

export function normalizeHistoryRetention(value) {
  const hours = Number(value);
  return HISTORY_RETENTION_OPTIONS.includes(hours) ? hours : DEFAULT_HISTORY_RETENTION_HOURS;
}

export function normalizeHistoryRange(query = {}, retentionHours = DEFAULT_HISTORY_RETENTION_HOURS, now = Date.now()) {
  const cutoff = now - normalizeHistoryRetention(retentionHours) * 3_600_000;
  const rawFrom = query.from === undefined ? now - 24 * 3_600_000 : query.from;
  const rawTo = query.to === undefined ? now : query.to;
  if (rawFrom === null || rawTo === null || rawFrom === '' || rawTo === ''
    || !Number.isFinite(Number(rawFrom)) || !Number.isFinite(Number(rawTo))) {
    throw new Error('请选择有效的开始和结束时间');
  }
  const from = Math.max(cutoff, Number(rawFrom));
  const to = Math.min(now, Number(rawTo));
  if (from >= to) throw new Error('当前区间超出保留周期，或结束时间早于开始时间');
  return { from, to, cutoff, now };
}
