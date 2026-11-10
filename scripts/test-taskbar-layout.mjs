import assert from 'node:assert/strict';
import { chooseTaskbarGap, retainTaskbarGeometry } from '../src/main/taskbar-layout.js';
import { normalizeConfig } from '../src/main/config-store.js';
const blocked = [[420, 600], [880, 1000], [0, 110], [100, 120]];
for (const position of ['left', 'center', 'right']) {
  const gap = chooseTaskbarGap(0, 1000, blocked, 200, position);
  assert.ok(gap);
  for (const [a, b] of blocked) assert.ok(gap.x >= b || gap.x + gap.width <= a);
}
assert.equal(chooseTaskbarGap(0, 100, [[0, 100]], 90, 'left'), null);
assert.ok(chooseTaskbarGap(0, 1000, [[100, 400], [720, 1000]], 500, 'left').width > 200);
const previous = normalizeConfig({ version: 19, overlay: { cornerRadius: 18 } });
assert.equal(previous.overlay.cornerRadius, 18);
assert.deepEqual(previous.taskbar, { visible: false, position: 'right' });
assert.deepEqual(normalizeConfig({ taskbar: { visible: true, position: 'center' } }).taskbar, { visible: true, position: 'center' });
const last = { shell: 123, left: 0, top: 950, right: 1000, bottom: 1000, controlsAvailable: true, blocked: [[0, 200], [850, 1000]] };
const temporary = { ...last, controlsAvailable: false, blocked: [[600, 700]] };
assert.deepEqual(retainTaskbarGeometry(last, temporary).blocked, [[0, 200], [850, 1000], [600, 700]]);
assert.deepEqual(retainTaskbarGeometry(last, { ...temporary, blocked: [] }).blocked, last.blocked);
assert.equal(retainTaskbarGeometry(null, temporary), null);
assert.equal(retainTaskbarGeometry(last, { ...temporary, shell: 456 }), null);
assert.equal(retainTaskbarGeometry(last, { ...temporary, top: 949 }), null);
assert.equal(retainTaskbarGeometry(last, null), null);
console.log('Taskbar placement and saved-settings checks passed');
