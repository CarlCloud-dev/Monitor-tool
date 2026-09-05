import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HISTORY_INTERVAL_SECONDS = 10;
export const HISTORY_RETENTION_OPTIONS = [1, 6, 24, 72, 168, 720];
const HISTORY_INTERVAL_MS = HISTORY_INTERVAL_SECONDS * 1000;
const HISTORY_METRIC_IDS = [
  'cpu.load', 'cpu.temp', 'cpu.power', 'cpu.fan',
  'memory.load',
  'gpu.load', 'gpu.temp', 'gpu.power', 'gpu.fan',
  'board.temp', 'disk.load', 'network.down', 'network.up'
];
const MAX_RESPONSE_POINTS = 1_200;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const retentionFor = (value) => {
  const numeric = Number(value);
  return HISTORY_RETENTION_OPTIONS.includes(numeric) ? numeric : 24;
};

const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const downsample = (records, maxPoints) => {
  if (records.length <= maxPoints) return records;
  const step = (records.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => records[Math.round(index * step)]);
};

export class HistoryStore {
  constructor(userDataPath, { enabled = true, retentionHours = 24 } = {}) {
    this.filePath = path.join(userDataPath, 'monitor-history.jsonl');
    this.enabled = enabled !== false;
    this.retentionHours = retentionFor(retentionHours);
    this.lastRecordedAt = 0;
    this.lastPrunedAt = 0;
    this.writeQueue = Promise.resolve();
  }

  getSettings() {
    return {
      enabled: this.enabled,
      retentionHours: this.retentionHours,
      intervalSeconds: HISTORY_INTERVAL_SECONDS
    };
  }

  setSettings(settings = {}) {
    const wasEnabled = this.enabled;
    const nextEnabled = settings.enabled !== false;
    const nextRetention = retentionFor(settings.retentionHours);
    const retentionChanged = nextRetention !== this.retentionHours;
    this.enabled = nextEnabled;
    this.retentionHours = nextRetention;
    if (!wasEnabled && nextEnabled) this.lastRecordedAt = 0;
    if (retentionChanged) void this.prune();
    return this.getSettings();
  }

  async recordSnapshot(snapshot) {
    if (!this.enabled || !snapshot) return false;
    const capturedAt = Number(snapshot.capturedAt) || Date.now();
    if (capturedAt - this.lastRecordedAt < HISTORY_INTERVAL_MS) return false;
    this.lastRecordedAt = capturedAt;
    const values = Object.fromEntries(HISTORY_METRIC_IDS.map((id) => [id, finiteOrNull(snapshot.metrics?.[id]?.value)]));
    const line = `${JSON.stringify({ capturedAt, values })}\n`;
    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, 'utf8');
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

  async readAll() {
    await this.writeQueue.catch(() => {});
    let content;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const cutoff = Date.now() - this.retentionHours * 60 * 60 * 1000;
    return content.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((record) => Number.isFinite(record?.capturedAt) && record.capturedAt >= cutoff && record.values && typeof record.values === 'object')
      .sort((left, right) => left.capturedAt - right.capturedAt);
  }

  async getView() {
    const records = await this.readAll();
    const first = records[0]?.capturedAt ?? null;
    const last = records.at(-1)?.capturedAt ?? null;
    return {
      settings: this.getSettings(),
      totalCount: records.length,
      from: first,
      to: last,
      records: downsample(records, MAX_RESPONSE_POINTS)
    };
  }

  async prune() {
    this.writeQueue = this.writeQueue.then(() => this.pruneNow(), () => this.pruneNow());
    await this.writeQueue.catch(() => {});
  }

  async pruneNow() {
    let content;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      this.lastPrunedAt = Date.now();
      return;
    }
    const cutoff = Date.now() - this.retentionHours * 60 * 60 * 1000;
    const kept = content.split(/\r?\n/).filter(Boolean).filter((line) => {
      try {
        const record = JSON.parse(line);
        return Number.isFinite(record?.capturedAt) && record.capturedAt >= cutoff;
      } catch {
        return false;
      }
    });
    const next = kept.length ? `${kept.join('\n')}\n` : '';
    if (next !== content) {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, next, 'utf8');
      await rename(temporaryPath, this.filePath);
    }
    this.lastPrunedAt = Date.now();
  }

  async clear() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, '', 'utf8');
      this.lastRecordedAt = 0;
      this.lastPrunedAt = Date.now();
    }, async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, '', 'utf8');
      this.lastRecordedAt = 0;
      this.lastPrunedAt = Date.now();
    });
    await this.writeQueue.catch(() => {});
  }
}
