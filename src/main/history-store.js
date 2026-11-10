import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createMetricSeriesAccumulator, finiteOrNull } from '../shared/history-series.js';
import { DEFAULT_HISTORY_RETENTION_HOURS, normalizeHistoryRetention, normalizeHistoryRange } from '../shared/history-options.js';
export { HISTORY_RETENTION_OPTIONS } from '../shared/history-options.js';

export const HISTORY_INTERVAL_SECONDS = 10;
export const HISTORY_METRIC_IDS = [
  'cpu.load', 'cpu.temp', 'cpu.power', 'cpu.fan',
  'memory.load', 'memory.temp',
  'gpu.load', 'gpu.temp', 'gpu.power', 'gpu.fan',
  'board.temp', 'disk.load', 'network.down', 'network.up'
];

const HISTORY_INTERVAL_MS = HISTORY_INTERVAL_SECONDS * 1000;
const MAX_RESPONSE_POINTS = 1_200;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const LEGACY_FILE_NAME = 'monitor-history.jsonl';
const SHARD_DIRECTORY_NAME = 'monitor-history';
const SHARD_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_FILES = 4;
const CACHE_IDLE_MS = 60_000;

const retentionFor = normalizeHistoryRetention;

const metricIdsFor = (value) => {
  if (!Array.isArray(value)) return [...HISTORY_METRIC_IDS];
  const selected = [...new Set(value.filter((id) => HISTORY_METRIC_IDS.includes(id)))];
  return selected.length ? selected : [...HISTORY_METRIC_IDS];
};

const dayStartFor = (timestamp) => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const shardNameFor = (timestamp) => new Date(timestamp).toISOString().slice(0, 10) + '.jsonl';

const shardTimestampFor = (name) => {
  const match = SHARD_NAME_PATTERN.exec(name);
  return match ? Date.parse(`${match[1]}T00:00:00.000Z`) : null;
};

const parseRecords = (contents) => contents
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter((record) => Number.isFinite(record?.capturedAt) && record.values && typeof record.values === 'object');

export class HistoryStore {
  constructor(userDataPath, { enabled = true, retentionHours = DEFAULT_HISTORY_RETENTION_HOURS, metricIds } = {}) {
    this.filePath = path.join(userDataPath, LEGACY_FILE_NAME);
    this.shardDirectory = path.join(userDataPath, SHARD_DIRECTORY_NAME);
    this.enabled = enabled !== false;
    this.retentionHours = retentionFor(retentionHours);
    this.metricIds = metricIdsFor(metricIds);
    this.lastRecordedAt = 0;
    this.lastPrunedAt = 0;
    this.writeQueue = Promise.resolve();
    this.fileCache = new Map();
    this.cacheActive = false;
    this.cacheEpoch = 0;
    this.cacheTimer = null;
    this.viewPromise = null;
    this.viewKey = '';
    this.viewGeneration = 0;
  }

  releaseCache() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    this.cacheEpoch += 1;
    this.fileCache.clear();
    this.viewPromise = null;
    this.viewKey = '';
    this.viewGeneration++;
  }

  setCacheActive(active) {
    this.cacheActive = active === true;
    if (!this.cacheActive) this.releaseCache();
  }

  cacheFile(filePath, entry, epoch) {
    // Do not repopulate caches after leaving the history page during an async read.
    if (!this.cacheActive || epoch !== this.cacheEpoch || entry.bytes > MAX_CACHE_BYTES) return;
    this.fileCache.delete(filePath);
    this.fileCache.set(filePath, entry);
    let bytes = [...this.fileCache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (bytes > MAX_CACHE_BYTES || this.fileCache.size > MAX_CACHE_FILES) {
      const oldest = this.fileCache.keys().next().value;
      bytes -= this.fileCache.get(oldest).bytes;
      this.fileCache.delete(oldest);
    }
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.releaseCache(), CACHE_IDLE_MS);
    this.cacheTimer.unref?.();
  }

  getSettings() {
    return {
      enabled: this.enabled,
      retentionHours: this.retentionHours,
      metricIds: [...this.metricIds],
      intervalSeconds: HISTORY_INTERVAL_SECONDS
    };
  }

  setSettings(settings = {}) {
    const wasEnabled = this.enabled;
    const nextEnabled = settings.enabled !== false;
    const nextRetention = retentionFor(settings.retentionHours);
    const nextMetricIds = metricIdsFor(settings.metricIds);
    const retentionChanged = nextRetention !== this.retentionHours;
    const settingsChanged = retentionChanged || wasEnabled !== nextEnabled
      || nextMetricIds.join(',') !== this.metricIds.join(',');
    this.enabled = nextEnabled;
    this.retentionHours = nextRetention;
    this.metricIds = nextMetricIds;
    if (settingsChanged) this.releaseCache();
    if (!wasEnabled && nextEnabled) this.lastRecordedAt = 0;
    if (retentionChanged) void this.prune();
    return this.getSettings();
  }

  async recordSnapshot(snapshot) {
    if (!this.enabled || !snapshot) return false;
    const capturedAt = Number(snapshot.capturedAt) || Date.now();
    if (capturedAt - this.lastRecordedAt < HISTORY_INTERVAL_MS) return false;
    this.lastRecordedAt = capturedAt;
    const values = Object.fromEntries(this.metricIds.map((id) => [id, finiteOrNull(snapshot.metrics?.[id]?.value)]));
    const line = `${JSON.stringify({ capturedAt, values })}\n`;
    const shardPath = path.join(this.shardDirectory, shardNameFor(capturedAt));
    const write = async () => {
      await mkdir(this.shardDirectory, { recursive: true });
      await appendFile(shardPath, line, 'utf8');
      // The current-day shard is the only file that changes during normal recording.
      this.fileCache.delete(shardPath);
      if (Date.now() - this.lastPrunedAt >= PRUNE_INTERVAL_MS) await this.pruneNow();
    };
    this.writeQueue = this.writeQueue.then(write, write);
    try {
      await this.writeQueue;
      return true;
    } catch {
      return false;
    }
  }

  async getSources(range) {
    let names = [];
    try { names = await readdir(this.shardDirectory); } catch { /* no shards yet */ }
    const retained = names.map((name) => ({ name, at: shardTimestampFor(name) }))
      .filter((entry) => entry.at !== null && entry.at + DAY_MS > range.cutoff && entry.at <= range.now)
      .sort((left, right) => left.at - right.at);
    const legacy = await stat(this.filePath).catch(() => null);
    const paths = retained.filter((entry) => entry.at <= range.to && entry.at + DAY_MS > range.from)
      .map((entry) => path.join(this.shardDirectory, entry.name));
    if (legacy?.size && legacy.mtimeMs >= range.from) paths.unshift(this.filePath);
    return {
      paths,
      archive: {
        shardCount: retained.length,
        availableFrom: legacy?.size ? range.cutoff : retained.length ? Math.max(range.cutoff, retained[0].at) : null,
        availableTo: retained.length ? Math.min(range.now, retained.at(-1).at + DAY_MS - 1) : legacy?.size ? Math.min(range.now, legacy.mtimeMs) : null
      }
    };
  }

  async *readSource(filePath, epoch, generation) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) { this.fileCache.delete(filePath); return; }
    const signature = `${fileStat.size}:${fileStat.mtimeMs}`;
    const cached = this.fileCache.get(filePath);
    if (cached?.signature === signature || fileStat.size <= 2 * 1024 * 1024) {
      const records = cached?.signature === signature ? cached.records
        : parseRecords(await readFile(filePath, 'utf8')).sort((left, right) => left.capturedAt - right.capturedAt);
      if (epoch !== this.cacheEpoch || generation !== this.viewGeneration) return;
      this.cacheFile(filePath, { signature, records, bytes: Math.max(fileStat.size * 4, records.length * 1024) }, epoch);
      for (let index = 0; index < records.length; index++) {
        if (epoch !== this.cacheEpoch || generation !== this.viewGeneration) return;
        yield records[index];
        if (index % 500 === 499) await yieldToEventLoop();
      }
      return;
    }
    // Large/legacy logs are streamed rather than retaining months of objects.
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let streamError = null;
    input.on('error', (error) => { streamError = error; reader.close(); });
    let count = 0;
    try {
      for await (const line of reader) {
        if (epoch !== this.cacheEpoch || generation !== this.viewGeneration) return;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (Number.isFinite(record?.capturedAt) && record.values && typeof record.values === 'object') yield record;
        if (++count % 500 === 0) await yieldToEventLoop();
      }
    } finally {
      reader.close();
      input.destroy();
    }
    if (streamError) throw new Error('读取历史分片失败，请刷新重试');
  }

  getView(query = {}) {
    const range = normalizeHistoryRange(query, this.retentionHours);
    const metricIds = Array.isArray(query.metricIds) ? [...new Set(query.metricIds.filter((id) => HISTORY_METRIC_IDS.includes(id)))] : [...HISTORY_METRIC_IDS];
    const key = JSON.stringify([range.from, range.to, metricIds]);
    if (this.viewPromise && key === this.viewKey) return this.viewPromise;
    const generation = ++this.viewGeneration;
    const pending = this.buildView(range, metricIds, generation).finally(() => {
      if (this.viewPromise === pending) this.viewPromise = null;
    });
    this.viewKey = key;
    this.viewPromise = pending;
    return pending;
  }

  async buildView(range, metricIds, generation) {
    const epoch = this.cacheEpoch;
    const cancelled = () => epoch !== this.cacheEpoch || generation !== this.viewGeneration;
    const cancelledView = () => ({ cancelled: true, settings: this.getSettings(), totalCount: 0, from: null, to: null, series: {} });
    await this.writeQueue.catch(() => {});
    if (cancelled()) return cancelledView();
    const { paths, archive } = await this.getSources(range);
    const accumulators = new Map(metricIds.map((id) => [id, createMetricSeriesAccumulator(range.from, range.to, MAX_RESPONSE_POINTS, HISTORY_INTERVAL_MS * 2)]));
    let first = null;
    let last = null;
    let count = 0;
    for (const filePath of paths) {
      for await (const record of this.readSource(filePath, epoch, generation)) {
        if (cancelled()) return cancelledView();
        if (record.capturedAt < range.from || record.capturedAt > range.to) continue;
        count++;
        first = first === null ? record.capturedAt : Math.min(first, record.capturedAt);
        last = last === null ? record.capturedAt : Math.max(last, record.capturedAt);
        for (const [id, accumulator] of accumulators) accumulator.add(record.capturedAt, record.values[id]);
      }
      await yieldToEventLoop();
    }
    if (cancelled()) return cancelledView();
    return {
      settings: this.getSettings(), totalCount: count, from: first, to: last,
      range: { from: range.from, to: range.to }, archive,
      series: Object.fromEntries([...accumulators].map(([id, accumulator]) => [id, accumulator.finish()]))
    };
  }

  async prune() {
    this.writeQueue = this.writeQueue.then(() => this.pruneNow(), () => this.pruneNow());
    await this.writeQueue.catch(() => {});
  }

  async pruneFile(filePath, cutoff) {
    let content;
    try { content = await readFile(filePath, 'utf8'); } catch { return false; }
    const kept = parseRecords(content)
      .filter((record) => record.capturedAt >= cutoff)
      .map((record) => JSON.stringify(record));
    const next = kept.length ? `${kept.join('\n')}\n` : '';
    if (next === content) return false;
    if (!next) {
      await unlink(filePath).catch(() => {});
      this.fileCache.delete(filePath);
      return true;
    }
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, next, 'utf8');
    await rename(temporaryPath, filePath);
    this.fileCache.delete(filePath);
    return true;
  }

  async pruneNow() {
    const cutoff = Date.now() - this.retentionHours * 60 * 60 * 1000;
    await this.pruneFile(this.filePath, cutoff);
    let shardNames = [];
    try { shardNames = await readdir(this.shardDirectory); } catch {
      this.lastPrunedAt = Date.now();
      return;
    }
    const cutoffDay = dayStartFor(cutoff);
    for (const name of shardNames) {
      const timestamp = shardTimestampFor(name);
      if (timestamp === null) continue;
      const filePath = path.join(this.shardDirectory, name);
      if (timestamp + DAY_MS <= cutoff) {
        const result = await unlink(filePath).then(() => true).catch(() => false);
        if (result) {
          this.fileCache.delete(filePath);
        }
      } else if (timestamp <= cutoffDay) {
        await this.pruneFile(filePath, cutoff);
      }
    }
    this.lastPrunedAt = Date.now();
  }

  async clear() {
    const clearFiles = async () => {
      await mkdir(this.shardDirectory, { recursive: true });
      let shardNames = [];
      try { shardNames = await readdir(this.shardDirectory); } catch { /* directory was just created */ }
      await Promise.all(shardNames
        .filter((name) => SHARD_NAME_PATTERN.test(name))
        .map((name) => unlink(path.join(this.shardDirectory, name)).catch(() => {})));
      await unlink(this.filePath).catch(() => {});
      this.releaseCache();
      this.lastRecordedAt = 0;
      this.lastPrunedAt = Date.now();
    };
    this.writeQueue = this.writeQueue.then(clearFiles, clearFiles);
    await this.writeQueue.catch(() => {});
  }
}
