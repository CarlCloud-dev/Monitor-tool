import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import si from 'systeminformation';

const runFile = promisify(execFile);
const numeric = (value) => value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null;

// Query live NVIDIA counters directly. si.graphics() also enumerates every
// monitor, registry adapter and display mode through separate PowerShell jobs.
export class GraphicsSampler {
  constructor() {
    this.executable = null;
    this.retryAt = 0;
    this.inventoryAt = 0;
    this.inventory = null;
  }

  async sample() {
    if (process.platform !== 'win32') return si.graphics();
    if (Date.now() >= this.retryAt) {
      const candidates = this.executable ? [this.executable] : [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
        'nvidia-smi.exe'
      ];
      for (const executable of candidates) {
        try {
          const { stdout } = await runFile(executable, [
            '--query-gpu=utilization.gpu,temperature.gpu,memory.total,memory.used,name',
            '--format=csv,noheader,nounits'
          ], { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 });
          const controllers = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const [load, temperature, total, used, ...name] = line.split(',').map((field) => field.trim());
            return {
              model: name.join(',').replace(/^"|"$/g, ''),
              utilizationGpu: numeric(load), temperatureGpu: numeric(temperature),
              memoryTotal: numeric(total), memoryUsed: numeric(used)
            };
          });
          if (!controllers.length || !controllers[0].model) throw new Error('No NVIDIA GPU counters');
          this.executable = executable;
          return { controllers };
        } catch (error) {
          if (error.code !== 'ENOENT') break;
        }
      }
      this.retryAt = Date.now() + 30_000;
    }
    // Retain adapter identification on machines without NVIDIA tooling. Live
    // AMD/Intel readings come from LHM; display inventory needs no fast polling.
    if (!this.inventoryAt || Date.now() - this.inventoryAt >= 60_000) {
      this.inventoryAt = Date.now();
      try {
        const inventory = await si.graphics();
        this.inventory = {
          controllers: (inventory.controllers ?? []).map((controller) => ({
            model: controller.model, memoryTotal: controller.memoryTotal ?? controller.vram
          }))
        };
      } catch { /* retry next minute */ }
    }
    return this.inventory;
  }
}
