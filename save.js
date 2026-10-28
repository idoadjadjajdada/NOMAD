// SaveSystem v1, pure (runs in node for tests). One save per seed, in localStorage. main.js builds the data and applies it.
export const SAVE_VERSION = 1;
export const saveKey = seed => `nomad.save.${seed}`;

// any older save shape -> the current one; null if it's unreadable or from a newer build
export function migrate(d, universe) {
  if (!d || typeof d !== 'object') return null;
  if (!d.v) d = { ...d, v: 1 }; // pre-version saves had the v1 shape
  if (d.v > SAVE_VERSION) return null;
  if (d.universe !== universe) { // the world under this seed changed: keep what you carry, drop where you were and what you mined
    d = { ...d }; delete d.craft; delete d.left; d.place = 'outside';
  }
  return d;
}

export function readSave(storage, seed, universe) {
  try { return migrate(JSON.parse(storage.getItem(saveKey(seed))), universe); } catch { return null; }
}

// false if it didn't fit (quota) or storage is off (private mode); the old save is left as it was
export function writeSave(storage, seed, data) {
  try { storage.setItem(saveKey(seed), JSON.stringify({ ...data, v: SAVE_VERSION })); return true; } catch { return false; }
}
