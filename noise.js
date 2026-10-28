// 3D value-noise fbm from a seeded random function. Shared by the page and the terrain worker.
export function makeNoise(r) {
  const perm = new Uint8Array(512), vals = new Float32Array(256);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) vals[i] = r();
  const lat = (x, y, z) => vals[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const s = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  function noise(x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const u = s(x - X), v = s(y - Y), w = s(z - Z);
    return lerp(
      lerp(lerp(lat(X, Y, Z), lat(X + 1, Y, Z), u), lerp(lat(X, Y + 1, Z), lat(X + 1, Y + 1, Z), u), v),
      lerp(lerp(lat(X, Y, Z + 1), lat(X + 1, Y, Z + 1), u), lerp(lat(X, Y + 1, Z + 1), lat(X + 1, Y + 1, Z + 1), u), v), w);
  }
  return (x, y, z, oct = 5) => {
    let a = 0, f = 1, amp = 0.5, norm = 0;
    for (let i = 0; i < oct; i++) { a += amp * noise(x * f, y * f, z * f); norm += amp; f *= 2.03; amp *= 0.5; }
    return a / norm;
  };
}
