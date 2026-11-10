// UI Automation can temporarily return an empty tree while Start is open.
// Reuse only data from the same shell window and identical taskbar bounds.
export function retainTaskbarGeometry(previous, current) {
  if (!current || !Array.isArray(current.blocked)) return null;
  if (current.controlsAvailable !== false && current.blocked.length) return current;
  if (!previous?.blocked?.length || !current.shell || current.shell !== previous.shell) return null;
  if (['left', 'top', 'right', 'bottom'].some(key => current[key] !== previous[key])) return null;
  return { ...current, blocked: [...previous.blocked, ...current.blocked] };
}

// Select a genuinely free span; never draw over taskbar controls.
export function chooseTaskbarGap(left, right, occupied, width, position) {
  const padding = 6;
  const spans = occupied.map(([a, b]) => [Math.max(left, a - padding), Math.min(right, b + padding)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = left + padding;
  for (const [a, b] of spans) {
    if (a > cursor) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < right - padding) gaps.push([cursor, right - padding]);
  const possible = gaps.filter(([a, b]) => b - a >= 70);
  if (!possible.length) return null;
  const fit = possible.filter(([a, b]) => b - a >= width);
  const largest = Math.max(...possible.map(([a, b]) => b - a));
  const candidates = fit.length ? fit : possible.filter(([a, b]) => b - a === largest);
  const midpoint = (left + right) / 2;
  const results = candidates.map(([a, b]) => {
    const actualWidth = Math.min(width, b - a);
    const x = position === 'left' ? a : position === 'right' ? b - actualWidth : Math.max(a, Math.min(b - actualWidth, midpoint - actualWidth / 2));
    return { x, width: actualWidth };
  });
  results.sort((a, b) => position === 'left' ? a.x - b.x : position === 'right' ? b.x - a.x : Math.abs(a.x + a.width / 2 - midpoint) - Math.abs(b.x + b.width / 2 - midpoint));
  return results[0];
}
