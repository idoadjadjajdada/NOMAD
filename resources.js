// Resources, pure data (no three.js): what each kind of world yields, where deposits sit, and the suit's kg inventory.
import { mulberry32, hash } from './universe.js';
import { FACES, faceDir, ihash } from './terrain.js';

// names match the ship's cargo bins (Bin_<name>); colours are the bin label colours
export const RESOURCES = {
  Iron:      { color: 0xbf4d26, label: 'IRON ORE' },
  Ice:       { color: 0x99d9ff, label: 'WATER ICE' },
  Silicate:  { color: 0xd9bf80, label: 'SILICATES' },
  Carbon:    { color: 0x4d4d52, label: 'CARBON' },
  RareMetal: { color: 0xd9b333, label: 'RARE METALS' },
  Exotic:    { color: 0xb34dff, label: 'EXOTIC MATTER' },
};
// refined goods: made at the refinery from hold resources, kept in the hold, spent on warp parts
export const REFINED = {
  Plate:     { color: 0x9aa4ad, label: 'ALLOY PLATE' },
  Wafer:     { color: 0x6fb7c9, label: 'SILICON WAFER' },
  Coolant:   { color: 0x5ad1e6, label: 'COOLANT' },
  Conductor: { color: 0xe0a040, label: 'SUPERCONDUCTOR' },
  Lattice:   { color: 0xc77dff, label: 'CORE LATTICE' },
};
export const itemInfo = t => RESOURCES[t] || REFINED[t] || { color: 0x888888, label: t.toUpperCase() };
// Recipes list fallbacks, best first; the refinery uses the first one the hold can pay. Before the warp works you can
// only land on the start world, so every kind of world must reach every warp part (tests/resources.test.mjs checks).
// Costs, times and research gates are placeholders until playtests (target: a 1 to 3 hour repair).
export const RECIPES = {
  Plate:     { out: 5, secs: 6,  in: [{ Iron: 10 }, { Silicate: 14, Carbon: 4 }, { Silicate: 20 }] },
  Wafer:     { out: 4, secs: 6,  in: [{ Silicate: 10 }] },
  Coolant:   { out: 6, secs: 5,  in: [{ Ice: 8 }, { Carbon: 8 }, { Silicate: 12 }] },
  Conductor: { out: 4, secs: 10, in: [{ RareMetal: 4, Silicate: 2 }, { Carbon: 12 }, { Iron: 16, Silicate: 4 }] },
  Lattice:   { out: 2, secs: 16, in: [{ Exotic: 3 }, { RareMetal: 8, Silicate: 8 }, { Carbon: 20, Silicate: 10 }] },
};
// the broken warp drive's four parts, made at the fabricator from refined goods; all four installed = drive online
export const WARP_PARTS = [
  { id: 'coolant', name: 'COOLANT LOOP', desc: 'KEEPS THE FIELD COIL COLD', cost: { Coolant: 12, Plate: 6 }, rp: 0, secs: 12 },
  { id: 'coil', name: 'FIELD COIL', desc: 'SHAPES THE WARP BUBBLE', cost: { Conductor: 8, Plate: 10 }, rp: 20, secs: 18 },
  { id: 'regulator', name: 'PHASE REGULATOR', desc: 'TIMES THE FIELD PULSES', cost: { Wafer: 10, Conductor: 4 }, rp: 40, secs: 16 },
  { id: 'lattice', name: 'CORE LATTICE', desc: 'HOLDS THE FIELD STEADY', cost: { Lattice: 4, Wafer: 4 }, rp: 60, secs: 24 },
];
// fuel, refined at the power panel: same fallback rule as RECIPES
export const FUEL = { ship: [{ Ice: 10 }, { Carbon: 8 }, { Silicate: 14 }], shipGain: 25,
  warp: [{ Silicate: 10, Carbon: 5 }, { Silicate: 10, RareMetal: 2 }, { Silicate: 10, Ice: 6 }], warpGain: 10 };
const coverage = (c, inv) => Object.entries(c).reduce((s, [t, kg]) => s + Math.min(1, (inv.items[t] || 0) / kg), 0) / Object.keys(c).length;
// the first option the hold can pay; failing that, the one it's closest to (so a world without exotic matter shows a path it has)
export const firstAffordable = (options, inv) => options.find(c => inv.has(c)) || options.reduce((b, c) => (coverage(c, inv) > coverage(b, inv) ? c : b));

// relative odds per world kind
const YIELD = {
  dead:   { Silicate: 4, Iron: 3, Carbon: 2, RareMetal: 0.6 },
  iron:   { Iron: 5, RareMetal: 1.5, Silicate: 1 },
  ice:    { Ice: 6, Carbon: 2, Silicate: 1 },
  desert: { Silicate: 5, Iron: 2, Carbon: 1, RareMetal: 0.4 },
  ocean:  { Silicate: 3, Ice: 2, Carbon: 2 },
  lava:   { Iron: 3, Silicate: 2, RareMetal: 2, Exotic: 0.3 },
};
// what a sample is made of, by mass; the analyzer shows it. Placeholders until a chemistry pass.
export const COMPOSITION = {
  Iron: [['Fe', 58], ['O', 26], ['Si', 9], ['Ni', 4], ['Mn', 3]], Ice: [['H2O', 91], ['CO2', 5], ['NH3', 3], ['DUST', 1]],
  Silicate: [['SiO2', 61], ['Al2O3', 15], ['FeO', 11], ['MgO', 8], ['CaO', 5]], Carbon: [['C', 74], ['H', 9], ['S', 7], ['N', 6], ['O', 4]],
  RareMetal: [['Pt', 31], ['Ir', 22], ['Pd', 19], ['Au', 15], ['Os', 13]], Exotic: [['???', 64], ['C', 18], ['Si', 11], ['UNKNOWN', 7]],
};
export const CELL_M = 40;      // one deposit lattice cell is about this wide
const DENSITY = 0.45;          // chance a cell holds a deposit

export function yieldsOf(kind) { return Object.keys(YIELD[kind] || {}); }

// which cube face and (u, v) a unit direction falls on; inverse of faceDir
export function dirToFace(d) {
  let face = 0, best = -Infinity;
  FACES.forEach(([n], f) => { const s = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]; if (s > best) { best = s; face = f; } });
  const [, r, up] = FACES[face], a = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / best, b = (up[0] * d[0] + up[1] * d[1] + up[2] * d[2]) / best;
  return { face, u: Math.atan(a) * 4 / Math.PI, v: Math.atan(b) * 4 / Math.PI };
}

// deposits in the cells around `dir` (unit, planet frame). Each cell draws the same randoms whatever is kept, so a
// deposit's id, place and size never change between visits. shortcut: only the face `dir` is on, so near a cube edge
// one side is empty; walk neighbouring faces if anyone lands there.
export function depositsNear(body, dir, rings = 3) {
  const table = YIELD[body.kind]; if (!table) return [];
  const names = Object.keys(table), total = names.reduce((s, k) => s + table[k], 0);
  const L = Math.max(1, Math.round(Math.log2(body.radius * Math.PI / 2 / CELL_M))), cells = 1 << L, du = 2 / cells;
  const { face, u, v } = dirToFace(dir), cx0 = Math.floor((u + 1) / du), cy0 = Math.floor((v + 1) / du);
  const seed = hash(body.seed, 'ore') | 0, out = [];
  for (let cy = cy0 - rings; cy <= cy0 + rings; cy++) for (let cx = cx0 - rings; cx <= cx0 + rings; cx++) {
    if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) continue;
    const r = mulberry32(ihash(face, L, cx, cy) ^ seed);
    const has = r(), fu = r(), fv = r(), pick = r() * total, size = r(), purity = r(), shape = r() * 1e9 | 0;
    if (has > DENSITY) continue;
    let type = names[0];
    for (let acc = 0, i = 0; i < names.length; i++) { acc += table[names[i]]; if (pick < acc) { type = names[i]; break; } }
    if (type === 'Ice' && body.temperature.surface > 260) type = names.find(n => n !== 'Ice') || 'Silicate'; // no surface ice on warm worlds
    const rare = type === 'RareMetal' || type === 'Exotic';
    out.push({ id: `${face}:${cx}:${cy}`, type, dir: faceDir(face, -1 + (cx + 0.15 + 0.7 * fu) * du, -1 + (cy + 0.15 + 0.7 * fv) * du),
      mass: Math.round((rare ? 15 : 30) + size * size * (rare ? 40 : 110)), purity: +(0.45 + 0.5 * purity).toFixed(2), shape });
  }
  return out;
}

// mass-based inventory: add() takes what fits and returns the kg actually stored
export function makeInventory(capacity) { // capacity can be raised later (upgrades)
  const items = {};
  const inv = {
    items, capacity,
    total: () => Object.values(items).reduce((s, v) => s + v, 0),
    free: () => Math.max(0, inv.capacity - inv.total()),
    add(type, kg) { const k = Math.min(kg, inv.free()); if (k > 0) items[type] = (items[type] || 0) + k; return k; },
    has: cost => Object.entries(cost).every(([t, kg]) => (items[t] || 0) >= kg - 1e-6),
    take(cost) { // all or nothing
      if (!inv.has(cost)) return false;
      for (const [t, kg] of Object.entries(cost)) { items[t] -= kg; if (items[t] < 1e-6) delete items[t]; }
      return true;
    },
    moveTo(store) { // whatever the store can't take stays in the suit
      let moved = 0;
      for (const [t, kg] of Object.entries(items)) { const m = store.add(t, kg); moved += m; items[t] -= m; if (items[t] < 1e-6) delete items[t]; }
      return moved;
    },
  };
  return inv;
}

// ---------- orbital scanning ----------
// what a deep scan reports: each resource's share of the surface deposits (warm worlds have no surface ice, as above)
export function abundance(body) {
  const t = { ...(YIELD[body.kind] || {}) };
  if (t.Ice && body.temperature?.surface > 260) { const alt = Object.keys(t).find(n => n !== 'Ice') || 'Silicate'; t[alt] = (t[alt] || 0) + t.Ice; delete t.Ice; }
  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  return Object.entries(t).map(([k, v]) => [k, v / sum]).sort((a, b) => b[1] - a[1]);
}
const RARITY = { Exotic: 10, RareMetal: 5, Carbon: 2, Ice: 1.5, Iron: 1, Silicate: 1 };
// the best deposit a survey finds within `rings` cells of dir (40 cells is about 1.6 km): rare and big beats near,
// but distance still counts. Skips the one you're standing on and anything `usable` rejects (the sea floor).
export function surveySite(body, dir, rings = 40, usable = () => true) {
  let best = null;
  for (const d of depositsNear(body, dir, rings)) {
    const dot = Math.min(1, d.dir[0] * dir[0] + d.dir[1] * dir[1] + d.dir[2] * dir[2]), dist = Math.acos(dot) * body.radius;
    if (dist < 60 || !usable(d.dir)) continue;
    const score = RARITY[d.type] * d.mass * d.purity / (1 + dist / 1500);
    if (!best || score > best.score) best = { ...d, dist, score };
  }
  return best;
}
