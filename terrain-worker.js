// Builds terrain chunks off the main thread. One request in, one chunk out (buffers transferred, not copied).
import { makeTerrain, buildChunk, planetTexture } from './terrain.js';

const terrains = new Map();
onmessage = ({ data: q }) => {
  if (q.type === 'texture') {
    const tx = planetTexture(q.body, q.w);
    return postMessage({ id: q.id, ...tx }, [tx.rgba.buffer, ...(tx.glow ? [tx.glow.buffer] : [])]);
  }
  let t = terrains.get(q.body.seed);
  if (!t) terrains.set(q.body.seed, t = makeTerrain(q.body));
  const t0 = performance.now();
  const c = buildChunk(t, q.face, q.level, q.ix, q.iy, q.segs, q.maxLevel);
  postMessage({ key: q.key, ms: performance.now() - t0, ...c }, [c.positions.buffer, c.normals.buffer, c.colors.buffer, c.index.buffer, ...(c.glow ? [c.glow.buffer] : [])]);
};
