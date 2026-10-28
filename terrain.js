// PlanetSurface data side: height field, colours, rocks and chunk meshes for solid bodies, as plain arrays (no three.js),
// so the terrain worker builds chunks and node tests can check them. Heights are metres above body.radius.
import { mulberry32, hash } from './universe.js';
import { makeNoise } from './noise.js';

// colour ramps per kind (sRGB hex), low ground to high; used for gas giants' bands and as a fallback
export const KIND_RAMPS = {
  iron:   [[0, 0x2a1208], [0.45, 0x6e2b14], [0.6, 0xa14a22], [0.8, 0xc9774a], [1, 0xe8b08a]],
  ice:    [[0, 0x5f7f9c], [0.4, 0x9cc2dd], [0.7, 0xdbeefa], [1, 0xffffff]],
  desert: [[0, 0x6b4b2a], [0.4, 0xb08850], [0.7, 0xd9b67c], [1, 0xf3dfb3]],
  dead:   [[0, 0x2b2b2e], [0.5, 0x5b5a5c], [0.8, 0x8f8d8a], [1, 0xc4c1bb]],
  ocean:  [[0, 0x061a4a], [0.5, 0x124c8c], [0.53, 0xcbb784], [0.6, 0x3c7a2e], [0.75, 0x285a22], [0.88, 0x7a7266], [1, 0xffffff]],
  lava:   [[0, 0x0d0b0a], [0.55, 0x2a2420], [0.8, 0x4a3a30], [1, 0x6b5546]],
};

// Per kind, in metres: continents + mountains (planet scale), mid (ridged hills ~3 km apart), roll (~300 m), rough (~25 m),
// grit (~4 m); crater, rock and dune amounts; palette (sRGB). Placeholders until we look at them on the Quest.
const KINDS = {
  dead:   { big: [2500, 3000], mid: 260, roll: 30, rough: 3, grit: 0.5, craters: 1, rocks: 1,
            pal: { base: 0x8a8580, rock: 0x57534f, dark: 0x3b3936, high: 0xbdb7ae, accent: 0xd4cec4 } },
  iron:   { big: [2000, 3500], mid: 300, roll: 35, rough: 3, grit: 0.5, craters: 0.8, rocks: 1.2,
            pal: { base: 0xa04c27, rock: 0x5a2a18, dark: 0x3a1b10, high: 0xd48b58, accent: 0x7a3a22 } },
  ice:    { big: [1200, 1500], mid: 140, roll: 18, rough: 2, grit: 0.3, craters: 0.5, rocks: 0.35, cracks: true,
            pal: { base: 0xdbe7f0, rock: 0x8ea7bc, dark: 0x6787a3, high: 0xffffff, accent: 0x2f6fa8 } },
  desert: { big: [1800, 2500], mid: 320, roll: 25, rough: 2, grit: 0.25, craters: 0.15, rocks: 0.5, terrace: 45, dunes: 7,
            pal: { base: 0xcfa66c, rock: 0x9a643a, dark: 0x7a5232, high: 0xead09a, accent: 0xb06a42 } },
  ocean:  { big: [3000, 3500], mid: 240, roll: 25, rough: 2.5, grit: 0.4, craters: 0.05, rocks: 0.6,
            pal: { base: 0x7b7266, rock: 0x4c4741, dark: 0x37332f, high: 0xa89f91, accent: 0xc9b68a, deep: 0x05182e, shallow: 0x1b5672, life: 0x4f6b38 } },
  lava:   { big: [1500, 4000], mid: 340, roll: 30, rough: 3.2, grit: 0.6, craters: 0.3, rocks: 1.3, cracks: true,
            pal: { base: 0x2e2724, rock: 0x161211, dark: 0x0d0b0a, high: 0x51443b, accent: 0xff6a10 } },
};

// cube faces as [normal, right, up]; right x up = normal, so grid triangles wound (a, b, d) face outward
export const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

export function faceDir(face, u, v, out = [0, 0, 0]) { // u, v in [-1, 1]; the tan warp evens out cell sizes
  const [n, r, up] = FACES[face], a = Math.tan(u * Math.PI / 4), b = Math.tan(v * Math.PI / 4);
  const x = n[0] + a * r[0] + b * up[0], y = n[1] + a * r[1] + b * up[1], z = n[2] + a * r[2] + b * up[2], l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

const toLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lin = hex => [hex >> 16, hex >> 8 & 255, hex & 255].map(c => toLinear(c / 255));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix3 = (out, c, f) => { for (let i = 0; i < 3; i++) out[i] += (c[i] - out[i]) * f; };

export function ihash(a, b, c, d) { // integer lattice hash -> uint32
  let h = Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ d;
  h = Math.imul(h ^ h >>> 15, 0x2c1b3c6d); h = Math.imul(h ^ h >>> 12, 0x297a2d39);
  return (h ^ h >>> 15) >>> 0;
}

export function makeTerrain(body) {
  const K = KINDS[body.kind], R = body.radius, sea = body.kind === 'ocean', [A0, A1] = K.big;
  const band = k => makeNoise(mulberry32(hash(body.seed, 'terrain', k)));
  const cont = band(0), mount = band(1), mid = band(2), roll = band(3), rough = band(4), grit = band(5),
    warp = band(6), patch = band(7), crackN = band(8), duneN = band(9);
  const unit = n => Math.max(-1, Math.min(1, (n - 0.5) * 4)); // fbm sits near 0.5 with a small spread; stretch it to about [-1, 1]
  const mf = R / 3000, rf = R / 300, hf = R / 25, gf = R / 4, pf = R / 2500, cf = R / 120, df = R / 110;
  const craterSeed = hash(body.seed, 'craters') | 0;
  // crater sizes from ~20 km down to a few metres: cells per unit radius, chance per cell, depth / radius
  const CRATERS = [[R / 40000, 0.45, 0.1], [R / 5000, 0.4, 0.16], [R / 600, 0.35, 0.2], [R / 70, 0.3, 0.22], [R / 12, 0.22, 0.25]]
    .map(([f, p, d]) => ({ f, p: p * K.craters, d, cell: R / f }));

  function craters(x, y, z) {
    if (!K.craters) return 0;
    let h = 0;
    for (let s = 0; s < CRATERS.length; s++) {
      const C = CRATERS[s], px = x * C.f, py = y * C.f, pz = z * C.f;
      const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        let k = ihash(cx + dx, cy + dy, cz + dz, craterSeed + s);
        if ((k & 0xffff) / 65536 >= C.p) continue;
        const ox = (k >>> 16 & 255) / 256, oy = (k >>> 24) / 256;
        k = ihash(k, s, 7, craterSeed);
        const oz = (k & 255) / 256, rr = (k >>> 8 & 255) / 256, r = 0.12 + 0.38 * rr * rr; // mostly small, some big
        const ex = px - (cx + dx + ox), ey = py - (cy + dy + oy), ez = pz - (cz + dz + oz);
        const q = Math.sqrt(ex * ex + ey * ey + ez * ez) / r;
        if (q > 1.8) continue;
        const depth = C.d * r * C.cell, rim = 0.22 * depth;
        h += q < 1 ? Math.max(q * q - 1, -0.82) * depth + rim : rim * Math.exp(-(q - 1) * 4.5);
      }
    }
    return h;
  }
  const crack = (x, y, z) => K.cracks ? 1 - Math.abs(unit(crackN(x * cf, y * cf, z * cf, 3))) : 0; // ~1 on thin lines

  const duneField = (x, y, z) => smooth(0.1, 0.5, unit(duneN(x * pf, y * pf + 9, z * pf, 2)));
  function raw(x, y, z) { // unit direction in, metres out; oceans may dip below sea level
    const c = unit(cont(x * 1.5 + 11, y * 1.5, z * 1.5, 6));
    const ridge = 1 - Math.abs(unit(mount(x * 4, y * 4, z * 4, 7)));
    let h = A0 * c + A1 * ridge ** 3 * smooth(0.1, 0.6, c);
    // mid-scale ridged hills, domain-warped so they wander instead of lining up on the noise grid
    const wx = x * mf + 2.2 * unit(warp(x * mf * 0.3, y * mf * 0.3, z * mf * 0.3, 3));
    const wy = y * mf + 2.2 * unit(warp(x * mf * 0.3 + 31.7, y * mf * 0.3, z * mf * 0.3, 3));
    const wz = z * mf + 2.2 * unit(warp(x * mf * 0.3, y * mf * 0.3 + 67.1, z * mf * 0.3, 3));
    const m = 1 - Math.abs(unit(mid(wx, wy, wz, 5)));
    const region = 0.35 + 0.65 * smooth(-0.4, 0.5, unit(patch(x * pf * 0.2, y * pf * 0.2, z * pf * 0.2, 2))); // rough lands vs plains
    let hm = K.mid * (m * m - 0.3) * region;
    if (K.terrace) { const t = hm / K.terrace, f = t - Math.floor(t); hm = (Math.floor(t) + smooth(0.55, 1, f)) * K.terrace; } // mesas; risers not quite vertical, so they don't alias into teeth
    h += hm;
    h += K.roll * unit(roll(x * rf, y * rf, z * rf, 4));
    h += K.rough * unit(rough(x * hf, y * hf, z * hf, 3)) * (0.5 + region);
    h += K.grit * unit(grit(x * gf, y * gf, z * gf, 2));
    if (K.dunes) { // sharp-crested dune ridges in patchy dune fields
      const s = (x * 0.8 + z * 0.6) * df + 1.5 * unit(duneN(x * df * 0.15, y * df * 0.15, z * df * 0.15, 2));
      const d = 1 - Math.abs((s - Math.floor(s)) * 2 - 1);
      h += K.dunes * d * d * duneField(x, y, z);
    }
    h += craters(x, y, z);
    if (K.cracks) h -= smooth(0.97, 0.99, crack(x, y, z)) * 1.2; // fissures (~2% of the ground) sit a little lower
    return h;
  }
  const height = sea ? (x, y, z) => Math.max(0, raw(x, y, z)) : raw; // oceans: a flat sea surface for now

  const P = Object.fromEntries(Object.entries(K.pal).map(([k, v]) => [k, lin(v)]));
  const hScale = 1 / (A0 + A1);
  // linear RGB into out[o..o+2]; returns glow (0..1) for lava fissures. slope = 1 - dot(normal, up), ao in 0..1.
  function color(x, y, z, h, slope, ao, out, o) {
    const c = [0, 0, 0], hn = h * hScale * 2, pn = unit(patch(x * pf, y * pf, z * pf, 3));
    let glow = 0;
    if (sea && h < 0) { // water: deep to shallow
      c[0] = P.deep[0]; c[1] = P.deep[1]; c[2] = P.deep[2];
      mix3(c, P.shallow, smooth(-120, 0, h));
    } else {
      c[0] = P.dark[0]; c[1] = P.dark[1]; c[2] = P.dark[2];
      mix3(c, P.base, smooth(-0.6, 0.15, hn + pn * 0.25));
      mix3(c, P.high, smooth(0.35, 0.9, hn) * 0.8);
      if (body.kind === 'dead' || body.kind === 'iron') mix3(c, P.accent, smooth(0.4, 0.9, pn) * 0.35); // pale dust drifts
      if (body.kind === 'desert') mix3(c, P.high, smooth(0.2, 0.7, pn) * 0.4);
      if (sea) {
        mix3(c, P.accent, 1 - smooth(4, 14, h)); // beaches
        if (body.life !== 'none') mix3(c, P.life, smooth(10, 40, h) * (1 - smooth(300, 900, h)) * smooth(-0.2, 0.4, pn) * 0.7);
      }
      const rock = [...P.rock];
      if (body.kind === 'desert') mix3(rock, P.accent, 0.5 + 0.5 * Math.sin(h / 6)); // strata on cliffs
      mix3(c, rock, smooth(0.16, 0.38, slope));
      if (K.cracks) {
        const k = smooth(0.97, 0.99, crack(x, y, z));
        if (body.kind === 'lava') glow = k * smooth(0.3, -0.3, hn); // fissures glow in the lowlands
        else mix3(c, P.accent, k * 0.8);
      }
    }
    const mottle = unit(grit(x * gf * 0.12, y * gf * 0.12, z * gf * 0.12, 2)); // the shader adds the fine detail
    const shade = (1 + 0.1 * pn + 0.06 * mottle) * ao;
    for (let i = 0; i < 3; i++) out[o + i] = Math.min(1, c[i] * shade);
    return glow;
  }
  const rockColor = P.rock.map((v, i) => v + (P.base[i] - v) * 0.75); // lit rocks sit between cliff rock and the ground around them
  // where loose rock collects: boulder fields (~800 m patches), steep ground and cliff feet; never on dunes or open sand
  const [flatRocks, steepRocks] = { dead: [0.55, 1.6], iron: [0.6, 1.8], lava: [0.7, 1.8], ice: [0.15, 0.9], desert: [0, 1.4], ocean: [0.25, 1.2] }[body.kind];
  function rockiness(x, y, z, grade) { // grade = rise over run
    const field = smooth(-0.5, 0.6, unit(patch(x * pf * 3, y * pf * 3, z * pf * 3, 2)));
    let r = flatRocks * (0.15 + 1.5 * field) + steepRocks * smooth(0.2, 0.7, grade);
    if (K.dunes) r *= 1 - smooth(0.05, 0.3, duneField(x, y, z));
    return r;
  }
  return { body, radius: R, height, raw, color, rocks: K.rocks, rockColor, rockiness, sea,
    min: sea ? 0 : -(A0 + K.mid * 0.5 + K.roll + K.rough * 1.5 + K.grit + 0.1 * CRATERS[0].cell + 2),
    max: A0 + A1 + K.mid + K.roll + K.rough * 1.5 + K.grit + (K.dunes || 0) + 0.03 * CRATERS[0].cell + 2 };
}

export const nodeSize = (R, level) => R * Math.PI / 2 / (1 << level); // arc length of a chunk edge, roughly

// rock classes: defined on cells `up` levels above the leaves, so the same rock shows in every chunk that covers it
// counts are candidates; rockiness thins them, so rocky ground gets crowded and smooth ground stays clear
const ROCKS = [{ up: 3, n: 18, size: [2, 6.5], spire: 0.15 }, { up: 2, n: 45, size: [0.6, 2.2], spire: 0 }, { up: 0, n: 70, size: [0.15, 0.7], spire: 0 }];

export function rocksFor(terrain, face, level, ix, iy, maxLevel) {
  const out = [], d = [0, 0, 0], d1 = [0, 0, 0], d2 = [0, 0, 0], du = 2 / (1 << level), u0 = -1 + ix * du, v0 = -1 + iy * du, seed = terrain.body.seed | 0;
  const R = terrain.radius, step = 3 / R, [, rt, up] = FACES[face];
  ROCKS.forEach((cls, k) => {
    const L = maxLevel - cls.up;
    if (level < L || L < 1) return;
    const shift = level - L, cx = ix >> shift, cy = iy >> shift, cdu = 2 / (1 << L);
    const r = mulberry32(ihash(face, L, cx, cy) ^ seed ^ k * 0x9e3779b9);
    const n = Math.round(cls.n * terrain.rocks);
    for (let i = 0; i < n; i++) { // every rock draws the same number of randoms, so filtering never shifts the next one
      const u = -1 + (cx + r()) * cdu, v = -1 + (cy + r()) * cdu, s = r(), yaw = r() * 6.283, spire = r() < cls.spire, shape = r() * 1e9 | 0, keep = r();
      if (u < u0 || u >= u0 + du || v < v0 || v >= v0 + du) continue;
      faceDir(face, u, v, d);
      const h0 = terrain.raw(d[0], d[1], d[2]);
      if (terrain.sea && h0 < 0.5) continue; // nothing on the sea floor yet
      for (let k = 0; k < 3; k++) { d1[k] = d[k] + rt[k] * step; d2[k] = d[k] + up[k] * step; }
      const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      const grade = Math.hypot(terrain.raw(d1[0] / l1, d1[1] / l1, d1[2] / l1) - h0, terrain.raw(d2[0] / l2, d2[1] / l2, d2[2] / l2) - h0) / 3;
      if (keep > 0.85 * terrain.rockiness(d[0], d[1], d[2], grade)) continue;
      out.push({ dir: [...d], size: cls.size[0] + (cls.size[1] - cls.size[0]) * s * s, yaw, spire, shape });
    }
  });
  return out;
}

const T = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]]
  .map(v => { const l = Math.hypot(...v); return v.map(c => c / l); });
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
export const ROCK_VERTS = ICO_F.length * 3;

// One quadtree chunk: (S+1)^2 grid vertices, 4 skirts of S+1 vertices hanging below the edges (hide LOD cracks), then rocks.
// Positions are relative to `center` (above the chunk's middle, at its mid height) so they stay precise as float32.
export function buildChunk(terrain, face, level, ix, iy, S, maxLevel = level) {
  const R = terrain.radius, du = 2 / (1 << level), u0 = -1 + ix * du, v0 = -1 + iy * du, spacing = nodeSize(R, level) / S;
  const G = S + 3; // one ring of extra samples around the grid, for normals and cavities
  const P = new Float64Array(G * G * 3), D = new Float64Array(G * G * 3), H = new Float64Array(G * G), HR = new Float64Array(G * G), d = [0, 0, 0];
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    faceDir(face, u0 + (i - 1) * du / S, v0 + (j - 1) * du / S, d);
    const g = j * G + i, raw = terrain.raw(d[0], d[1], d[2]), h = terrain.sea ? Math.max(0, raw) : raw;
    H[g] = h; HR[g] = raw;
    for (let k = 0; k < 3; k++) { D[g * 3 + k] = d[k]; P[g * 3 + k] = d[k] * (R + h); }
    if (i > 0 && j > 0 && i < G - 1 && j < G - 1) { minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
  }
  const rocks = rocksFor(terrain, face, level, ix, iy, maxLevel);
  const center = faceDir(face, u0 + du / 2, v0 + du / 2).map(c => c * (R + (minH + maxH) / 2));
  for (let g = 0; g < G * G; g++) for (let k = 0; k < 3; k++) P[g * 3 + k] -= center[k];

  const V = (S + 1) * (S + 1), grid = V + 4 * (S + 1), count = grid + rocks.length * ROCK_VERTS;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const glow = terrain.body.kind === 'lava' ? new Float32Array(count) : null;
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const g = (j + 1) * G + i + 1, o = (j * (S + 1) + i) * 3;
    const ax = P[(g + 1) * 3] - P[(g - 1) * 3], ay = P[(g + 1) * 3 + 1] - P[(g - 1) * 3 + 1], az = P[(g + 1) * 3 + 2] - P[(g - 1) * 3 + 2];
    const bx = P[(g + G) * 3] - P[(g - G) * 3], by = P[(g + G) * 3 + 1] - P[(g - G) * 3 + 1], bz = P[(g + G) * 3 + 2] - P[(g - G) * 3 + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    positions[o] = P[g * 3]; positions[o + 1] = P[g * 3 + 1]; positions[o + 2] = P[g * 3 + 2];
    normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
    // hollows read darker, crests a touch lighter (cheap stand-in for ambient occlusion)
    const cav = ((H[g - 1] + H[g + 1] + H[g - G] + H[g + G]) / 4 - H[g]) / spacing;
    const ao = 1 - Math.min(0.45, Math.max(0, cav * 1.5)) + Math.min(0.08, Math.max(0, -cav * 0.4));
    const gl = terrain.color(D[g * 3], D[g * 3 + 1], D[g * 3 + 2], HR[g], 1 - (nx * D[g * 3] + ny * D[g * 3 + 1] + nz * D[g * 3 + 2]), ao, colors, o);
    if (glow) glow[o / 3] = gl;
  }
  const skirt = spacing * 2 + 5;
  const edges = [k => [k, 0], k => [k, S], k => [0, k], k => [S, k]]; // bottom, top, left, right
  edges.forEach((edge, e) => {
    for (let k = 0; k <= S; k++) {
      const [i, j] = edge(k), src = (j * (S + 1) + i) * 3, o = (V + e * (S + 1) + k) * 3, g = ((j + 1) * G + i + 1) * 3;
      for (let c = 0; c < 3; c++) {
        positions[o + c] = positions[src + c] - D[g + c] * skirt;
        normals[o + c] = normals[src + c]; colors[o + c] = colors[src + c];
      }
      if (glow) glow[o / 3] = glow[src / 3];
    }
  });

  // rocks: jittered, squashed icosahedra with flat faces, sunk a third into the ground
  const right = FACES[face][1], rv = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  rocks.forEach((rk, n) => {
    const [ux, uy, uz] = rk.dir, h = terrain.height(ux, uy, uz), rs = mulberry32(rk.shape);
    let tx = right[0] - ux * (right[0] * ux + right[1] * uy + right[2] * uz), ty = right[1] - uy * (right[0] * ux + right[1] * uy + right[2] * uz),
      tz = right[2] - uz * (right[0] * ux + right[1] * uy + right[2] * uz);
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = uy * tz - uz * ty, by = uz * tx - ux * tz, bz = ux * ty - uy * tx; // up x t
    const cs = Math.cos(rk.yaw), sn = Math.sin(rk.yaw);
    // (ex, up, ez) must be right-handed or the icosahedron turns inside out: ez = ex x up
    const ex = [tx * cs + bx * sn, ty * cs + by * sn, tz * cs + bz * sn], ez = [tx * sn - bx * cs, ty * sn - by * cs, tz * sn - bz * cs];
    const type = rk.spire ? 3 : rs(); // < 0.25 slab, < 0.85 boulder, else shard
    const [ya, yb, xa, xb] = type === 3 ? [1.6, 3.2, 0.45, 0.6] : type < 0.25 ? [0.22, 0.38, 0.9, 1.5] : type < 0.85 ? [0.45, 0.8, 0.75, 1.25] : [0.9, 1.5, 0.45, 0.75];
    const sy = rk.size * (ya + rs() * (yb - ya)), sx = rk.size * (xa + rs() * (xb - xa)), sz = rk.size * (xa + rs() * (xb - xa));
    const base = [ux * (R + h - sy * 0.35) - center[0], uy * (R + h - sy * 0.35) - center[1], uz * (R + h - sy * 0.35) - center[2]];
    const jit = ICO_V.map(() => type > 0.85 ? 0.55 + rs() * 0.9 : 0.72 + rs() * 0.5); // shards are more jagged
    const tint = 0.75 + rs() * 0.4;
    maxH = Math.max(maxH, h + sy);
    const vert = (vi, out) => {
      const [lx, ly, lz] = ICO_V[vi], j = jit[vi], px = lx * sx * j, py = ly * sy * j, pz = lz * sz * j;
      for (let k = 0; k < 3; k++) out[k] = base[k] + ex[k] * px + rk.dir[k] * py + ez[k] * pz;
    };
    ICO_F.forEach((f, fi) => {
      vert(f[0], a); vert(f[1], b); vert(f[2], c);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      rv[0] = e1[1] * e2[2] - e1[2] * e2[1]; rv[1] = e1[2] * e2[0] - e1[0] * e2[2]; rv[2] = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(...rv), up = (rv[0] * ux + rv[1] * uy + rv[2] * uz) / nl;
      const shade = tint * (0.8 + 0.4 * Math.max(0, up));
      [a, b, c].forEach((p, k) => {
        const o = (grid + n * ROCK_VERTS + fi * 3 + k) * 3;
        for (let q = 0; q < 3; q++) { positions[o + q] = p[q]; normals[o + q] = rv[q] / nl; colors[o + q] = Math.min(1, terrain.rockColor[q] * shade); }
      });
    });
  });

  const base = chunkIndex(S), index = new (count > 65535 ? Uint32Array : Uint16Array)(base.length + rocks.length * ROCK_VERTS);
  index.set(base);
  for (let i = 0; i < rocks.length * ROCK_VERTS; i++) index[base.length + i] = grid + i;
  return { center, positions, normals, colors, glow, index, minH, maxH, rocks: rocks.length };
}

export function chunkIndex(S) { // grid + skirts, the same for every chunk with this S
  const v = (i, j) => j * (S + 1) + i, sk = (e, k) => (S + 1) * (S + 1) + e * (S + 1) + k;
  const idx = [];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) idx.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  for (let k = 0; k < S; k++) { // each skirt faces away from the chunk
    const E = [v(k, 0), v(k, S), v(0, k), v(S, k)], E1 = [v(k + 1, 0), v(k + 1, S), v(0, k + 1), v(S, k + 1)];
    for (const [e, flip] of [[0, false], [1, true], [2, true], [3, false]]) {
      const a = E[e], b = E1[e], s0 = sk(e, k), s1 = sk(e, k + 1);
      if (flip) idx.push(a, b, s0, b, s1, s0); else idx.push(a, s0, b, b, s0, s1);
    }
  }
  return new Uint16Array(idx);
}

const toSRGB = c => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
// equirect RGBA (sRGB bytes) for the far-away sphere, rows laid out for a DataTexture on three's SphereGeometry
// (row 0 = south pole, u = longitude from -x), so it lines up with the streamed terrain. Lava also gets a glow map.
export function planetTexture(body, w) {
  const t = makeTerrain(body), h = w / 2, rgba = new Uint8Array(w * h * 4), glow = body.kind === 'lava' ? new Uint8Array(w * h * 4) : null, c = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const th = (1 - (y + 0.5) / h) * Math.PI, ph = (x + 0.5) / w * 2 * Math.PI;
    const dx = -Math.cos(ph) * Math.sin(th), dy = Math.cos(th), dz = Math.sin(ph) * Math.sin(th), i = (y * w + x) * 4;
    const g = t.color(dx, dy, dz, t.raw(dx, dy, dz), 0, 1, c, 0);
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(toSRGB(c[k]) * 255);
    rgba[i + 3] = 255;
    if (glow) { glow[i] = 255 * g; glow[i + 1] = 77 * g; glow[i + 2] = 13 * g; glow[i + 3] = 255; }
  }
  return { rgba, glow, w, h };
}
