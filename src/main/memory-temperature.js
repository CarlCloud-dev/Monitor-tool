import { finiteOrNull } from '../shared/history-series.js';

// LHM DimmMemory exposes the live SPD temperature at index 0. Other
// Temperature sensors on the same DIMM are static limits or resolution values.
// Match the physical memory identity too, never a GPU memory junction or CPU IMC.
export const isMemoryTemperatureSensor = (sensor) => sensor?.sensorType === 'Temperature'
  && sensor.hardwareType === 'Memory'
  && /^\/memory\/dimm\/[^/]+\/temperature\/0$/i.test(sensor.identifier ?? '');

export function readMemoryTemperature(sensors = []) {
  const unique = new Map();
  for (const sensor of sensors) {
    if (!isMemoryTemperatureSensor(sensor)) continue;
    const value = finiteOrNull(sensor.value);
    unique.set(sensor.identifier, {
      identifier: sensor.identifier,
      name: sensor.name || sensor.hardwareName || 'DIMM',
      hardwareName: sensor.hardwareName,
      value: value !== null && value > 0 ? value : null
    });
  }
  const modules = [...unique.values()].sort((left, right) => left.identifier.localeCompare(right.identifier, undefined, { numeric: true }));
  const readable = modules.filter((module) => module.value !== null);
  return {
    value: readable.length ? Math.max(...readable.map((module) => module.value)) : null,
    modules,
    detectedCount: modules.length,
    readableCount: readable.length,
    detail: readable.length ? `LHM · 可读最高温（${readable.length}/${modules.length} 条） · ${modules.map((module) => `${module.name} ${module.value === null ? '暂不可用' : module.value.toFixed(1) + '°C'}`).join(' / ')}` : null
  };
}
