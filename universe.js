// UniverseGenerator: seeded star systems as plain data (no three.js), so node tests and a later worker can run it.
// Units: metres, kilograms, seconds, kelvin. Every body draws from its own hashed stream of (galaxySeed, system, path),
// so adding a field or a body later never reshuffles bodies that already exist.
export const UNIVERSE_VERSION = 1;

export const AU = 1.495978707e11, R_EARTH = 6.371e6, M_EARTH = 5.972e24, R_SUN = 6.957e8, M_SUN = 1.989e30;
const G = 6.674e-11;

// tuning placeholders, not approved numbers: adjust after Quest playtests
export const CONFIG = {
  planets: [2, 6],
  // life is hidden state for now; complex life needs microbial life first
  life: { microbialHZOcean: 0.3, complexGivenMicrobial: 0.1, microbialIcyMoon: 0.04 },
  startOrbit: 2.55, // parking orbit radius in body radii; keeps the old view of the home planet
};

export function hash(...parts) { // FNV-1a over the joined parts, then the murmur3 finaliser
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function stream(...parts) {
  const r = mulberry32(hash(...parts));
  const range = (a, b) => a + (b - a) * r();
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const weighted = list => { let x = r() * list.reduce((s, e) => s + e.w, 0); return list.find(e => (x -= e.w) < 0) ?? list.at(-1); };
  return { r, range, pick, weighted };
}

// rough main-sequence frequencies, nudged toward brighter stars so fewer systems are dim red dwarfs
const STAR_CLASSES = [
  { cls: 'M', w: 0.5, mass: [0.1, 0.55] }, { cls: 'K', w: 0.22, mass: [0.6, 0.88] },
  { cls: 'G', w: 0.14, mass: [0.88, 1.12] }, { cls: 'F', w: 0.09, mass: [1.12, 1.5] },
  { cls: 'A', w: 0.04, mass: [1.5, 2.4] }, { cls: 'B', w: 0.01, mass: [2.5, 8] },
];
const EXOTICS = [
  { kind: 'blackhole', ly: [80, 900] }, { kind: 'pulsar', ly: [300, 3000] },
  { kind: 'neutron', ly: [100, 1000] }, { kind: 'quasar', ly: [1e9, 3e9] },
];
const SYL = ['ka', 'vel', 'or', 'th', 'ix', 'sa', 'mur', 'en', 'qa', 'dro', 'lu', 'zen', 'ta', 'rho', 'ny'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function makeStar(cls, mass) { // main-sequence approximations: L ~ M^3.5 (M^2.3 below 0.43), R ~ M^0.8 (M^0.57 above 1)
  const lum = mass < 0.43 ? 0.23 * mass ** 2.3 : mass ** 3.5;
  return { cls, mass: mass * M_SUN, radius: (mass < 1 ? mass ** 0.8 : mass ** 0.57) * R_SUN, luminosity: lum,
    hz: [0.95 * Math.sqrt(lum) * AU, 1.67 * Math.sqrt(lum) * AU], frostLine: 2.7 * Math.sqrt(lum) * AU };
}

// fills in everything that follows from kind, size and orbit, so generated and hand-made bodies agree
function finish(b, star, parentMass, distToStar) {
  b.gravity = G * b.mass / b.radius ** 2;
  b.orbit.period = 2 * Math.PI * Math.sqrt(b.orbit.a ** 3 / (G * parentMass));
  const teq = 254.9 * star.luminosity ** 0.25 / Math.sqrt(distToStar / AU); // albedo 0.3
  const p = b.atmosphere.pressure ?? 0;
  b.temperature = { eq: Math.round(teq), surface: Math.round(teq * (1 + 0.75 * 0.84 * p ** 1.1) ** 0.25) }; // grey greenhouse, tuned to Earth and Venus
  if (b.kind === 'ocean' && b.temperature.surface > 360) { b.kind = 'desert'; b.water = 'none'; }
  return b;
}

const ATMOS = { // [pressure range in bar, composition]
  dead: [[0, 0.01], 'trace'], iron: [[0, 0.01], 'trace'], ice: [[0, 0.3], 'N2-CH4'],
  desert: [[0.005, 0.8], 'CO2'], ocean: [[0.5, 3], 'N2-CO2'], lava: [[0, 0.02], 'SO2'],
};
function rockyKind(s, teq, inHZ) {
  let kind;
  if (teq > 650) kind = 'lava';
  else if (teq > 400) kind = s.r() < 0.5 ? 'desert' : 'dead';
  else if (teq >= 240) kind = inHZ && s.r() < 0.45 ? 'ocean' : s.pick(['desert', 'dead', 'iron']);
  else if (teq >= 150) kind = s.pick(['ice', 'dead', 'iron', 'desert']);
  else kind = s.r() < 0.7 ? 'ice' : 'dead';
  return kind;
}
function rockyBody(s, kind, radiusE) {
  const [pr, comp] = ATMOS[kind];
  const thick = kind === 'lava' && s.r() < 0.3; // a Venus now and then
  return { kind, radius: radiusE * R_EARTH, mass: radiusE ** 3.7 * (kind === 'iron' ? 1.4 : 1) * M_EARTH,
    atmosphere: { pressure: thick ? s.range(20, 95) : s.range(...pr) * Math.min(1, radiusE), composition: thick ? 'CO2-SO2' : comp },
    water: kind === 'ocean' ? 'surface' : kind === 'ice' ? 'ice crust' : 'none' };
}

export function generateSystem(galaxySeed, index) {
  const id = `${galaxySeed}:${index}`;
  const s = stream(galaxySeed, index, 'star');
  const sc = s.weighted(STAR_CLASSES);
  const star = makeStar(sc.cls, s.range(...sc.mass));
  const name = (s.pick(SYL) + s.pick(SYL)).replace(/^./, c => c.toUpperCase()) + '-' + (100 + Math.floor(s.r() * 9900));
  const bodies = [];
  const nPlanets = CONFIG.planets[0] + Math.floor(s.r() * (CONFIG.planets[1] - CONFIG.planets[0] + 1));
  let a = s.range(0.25, 0.5) * Math.sqrt(star.luminosity) * AU;
  for (let i = 0; i < nPlanets; i++) {
    const ps = stream(galaxySeed, index, 'planet', i);
    if (i) a *= ps.range(1.4, 2.0);
    const teq = 254.9 * star.luminosity ** 0.25 / Math.sqrt(a / AU);
    const inHZ = a >= star.hz[0] && a <= star.hz[1];
    let b;
    if (i > 0 && a > star.frostLine && ps.r() < 0.65) { // the innermost planet is always rocky, so there's somewhere to start
      b = { kind: 'gas', radius: ps.range(3.5, 11.5) * R_EARTH, mass: ps.range(15, 320) * M_EARTH,
        atmosphere: { pressure: null, composition: 'H2-He' }, water: 'none', rings: ps.r() < 0.6 };
    } else {
      let kind = rockyKind(ps, teq, inHZ);
      const radiusE = ps.range(0.3, 1.7);
      if (radiusE < 1 && ps.r() < 0.12) kind = 'iron';
      b = rockyBody(ps, kind, radiusE);
    }
    Object.assign(b, { id: `${id}/p${i}`, type: 'planet', parent: null, name: `${name} ${String.fromCharCode(98 + i)}`,
      seed: hash(galaxySeed, index, 'planet', i, 'surface'), dayLength: ps.range(8, 60) * 3600, tilt: ps.range(0, 0.5),
      orbit: { a, e: ps.range(0, 0.08), inc: ps.range(-0.04, 0.04), node: ps.range(0, 6.283), peri: ps.range(0, 6.283), m0: ps.range(0, 6.283) },
      life: 'none' });
    finish(b, star, star.mass, a);
    if (b.kind === 'ocean' && inHZ && ps.r() < CONFIG.life.microbialHZOcean)
      b.life = ps.r() < CONFIG.life.complexGivenMicrobial ? 'complex' : 'microbial';
    bodies.push(b);

    // moons stay inside 40% of the planet's Hill sphere
    const hill = a * Math.cbrt(b.mass / (3 * star.mass));
    const nMoons = b.kind === 'gas' ? Math.floor(ps.r() * 5) : b.radius > 0.6 * R_EARTH ? ps.weighted([{ n: 0, w: 5 }, { n: 1, w: 3 }, { n: 2, w: 1 }]).n : 0;
    let ma = b.radius * ps.range(4, 12);
    for (let j = 0; j < nMoons; j++) {
      const ms = stream(galaxySeed, index, 'planet', i, 'moon', j);
      if (j) ma *= ms.range(1.5, 2.5);
      if (ma > 0.4 * hill) break;
      const moonR = Math.min(b.radius * 0.4 / R_EARTH, ms.range(b.kind === 'gas' ? 0.05 : 0.08, b.kind === 'gas' ? 0.45 : 0.35));
      const kind = b.kind === 'gas' && ms.r() < 0.1 ? 'lava' : rockyKind(ms, teq, false) === 'ice' ? 'ice' : ms.pick(['dead', 'dead', 'iron', 'ice']);
      const m = rockyBody(ms, kind, moonR);
      Object.assign(m, { id: `${b.id}/m${j}`, type: 'moon', parent: b.id, name: `${b.name} ${ROMAN[j] ?? j + 1}`,
        seed: hash(galaxySeed, index, 'planet', i, 'moon', j, 'surface'), dayLength: 0, tilt: 0, // tidally locked
        orbit: { a: ma, e: ms.range(0, 0.05), inc: ms.range(-0.1, 0.1), node: ms.range(0, 6.283), peri: ms.range(0, 6.283), m0: ms.range(0, 6.283) },
        life: 'none' });
      finish(m, star, b.mass, a);
      m.dayLength = m.orbit.period;
      if (m.kind === 'ice' && b.kind === 'gas' && ms.r() < CONFIG.life.microbialIcyMoon) m.life = 'microbial'; // under the ice
      bodies.push(m);
    }
  }
  return finishSystem({ version: UNIVERSE_VERSION, id, galaxySeed, index, name, star, bodies }, s);
}

// start over the solid body nearest the middle of the habitable zone; the sky gets one distant exotic object
function finishSystem(sys, s) {
  const hzMid = (sys.star.hz[0] + sys.star.hz[1]) / 2;
  const solid = sys.bodies.filter(b => b.kind !== 'gas');
  const distOf = b => b.parent ? sys.bodies.find(p => p.id === b.parent).orbit.a : b.orbit.a;
  const start = solid.reduce((best, b) => Math.abs(Math.log(distOf(b) / hzMid)) < Math.abs(Math.log(distOf(best) / hzMid)) ? b : best);
  sys.start = { body: start.id, orbitRadius: start.radius * CONFIG.startOrbit, phase: s.range(0.5, 1.4) };
  // keep the exotic out of the sun's glare as seen from the start body
  const toSun = positionAt(start, 0, sys.bodies).map(v => -v), len = Math.hypot(...toSun);
  const ex = s.pick(EXOTICS);
  let dir;
  do {
    const z = s.range(-0.3, 0.5), t = s.range(0, 6.283), rr = Math.sqrt(1 - z * z);
    dir = [rr * Math.cos(t), z, rr * Math.sin(t)];
  } while ((dir[0] * toSun[0] + dir[1] * toSun[1] + dir[2] * toSun[2]) / len > 0.5);
  sys.sky = { exotic: { kind: ex.kind, dir, distanceLy: s.range(...ex.ly) } };
  return sys;
}

// a fixed star + planet + moon for testing terrain, streaming and landing without random surprises
export function testSystem(galaxySeed = 1) {
  const id = `${galaxySeed}:test`;
  const s = stream(galaxySeed, 'test');
  const star = makeStar('G', 1);
  const a = AU;
  const planet = finish(Object.assign(rockyBody(stream(id, 'p'), 'desert', 0.6), {
    id: `${id}/p0`, type: 'planet', parent: null, name: 'Test b', seed: hash(id, 'p0'), dayLength: 20 * 3600, tilt: 0.3,
    orbit: { a, e: 0.02, inc: 0, node: 0, peri: 0, m0: 1 }, life: 'none' }), star, star.mass, a);
  const moon = finish(Object.assign(rockyBody(stream(id, 'm'), 'dead', 0.15), {
    id: `${id}/p0/m0`, type: 'moon', parent: planet.id, name: 'Test b I', seed: hash(id, 'm0'), dayLength: 0, tilt: 0,
    orbit: { a: planet.radius * 9, e: 0.01, inc: 0.05, node: 0, peri: 0, m0: 2 }, life: 'none' }), star, planet.mass, a);
  moon.dayLength = moon.orbit.period;
  return finishSystem({ version: UNIVERSE_VERSION, id, galaxySeed, index: 'test', name: 'Test', star, bodies: [planet, moon] }, s);
}

// position in the system frame (star at the origin, y up, orbits roughly in the xz plane), in metres
export function positionAt(body, t, bodies, out = [0, 0, 0]) {
  const o = body.orbit;
  const M = o.m0 + 2 * Math.PI * (t / o.period % 1);
  let E = M;
  for (let k = 0; k < 6; k++) E -= (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E)); // Newton on Kepler's equation
  const x0 = o.a * (Math.cos(E) - o.e), y0 = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const px = x0 * Math.cos(o.peri) - y0 * Math.sin(o.peri), pz = x0 * Math.sin(o.peri) + y0 * Math.cos(o.peri);
  const py = pz * Math.sin(o.inc), pz2 = pz * Math.cos(o.inc);
  const x = px * Math.cos(o.node) + pz2 * Math.sin(o.node), z = -px * Math.sin(o.node) + pz2 * Math.cos(o.node);
  if (body.parent) positionAt(bodies.find(b => b.id === body.parent), t, bodies, out); else out[0] = out[1] = out[2] = 0;
  out[0] += x; out[1] += py; out[2] += z;
  return out;
}

// ---------- the local star map, flat because the radar is 2D ----------
// One cell per 7 light-years; about half hold a star at a hashed spot. The home system (index 0) is the star in cell
// 0,0, which always has one. Other systems are indexed by their cell, "x,y", and generated with generateSystem.
export const STAR_CELL_LY = 7;
export function starAt(galaxySeed, cx, cy) {
  const home = cx === 0 && cy === 0, r = mulberry32(hash(galaxySeed, 'cell', cx, cy));
  const has = r() < 0.55 || home, fu = r(), fv = r();
  return has ? { index: home ? 0 : `${cx},${cy}`, pos: [(cx + 0.15 + 0.7 * fu) * STAR_CELL_LY, (cy + 0.15 + 0.7 * fv) * STAR_CELL_LY] } : null;
}
export const cellOf = index => (String(index) === '0' ? [0, 0] : String(index).split(',').map(Number));
// stars within rangeLy of system `index`, nearest first; rel is the offset in light-years (x east, y north on the radar)
export function starsNear(galaxySeed, index, rangeLy) {
  const [cx, cy] = cellOf(index), here = starAt(galaxySeed, cx, cy).pos, n = Math.ceil(rangeLy / STAR_CELL_LY) + 1, out = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
    if (!dx && !dy) continue;
    const s = starAt(galaxySeed, cx + dx, cy + dy); if (!s) continue;
    const rel = [s.pos[0] - here[0], s.pos[1] - here[1]], dist = Math.hypot(rel[0], rel[1]);
    if (dist <= rangeLy) out.push({ ...s, rel, dist });
  }
  return out.sort((a, b) => a.dist - b.dist);
}
