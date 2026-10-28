import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { generateSystem, testSystem, positionAt, mulberry32, hash, UNIVERSE_VERSION } from './universe.js';
import { createPerf } from './perf.js';
import { makeNoise } from './noise.js';
import { KIND_RAMPS } from './terrain.js'; // gas giant bands
import { PlanetSurface } from './surface.js';
import { makeCockpitScreens } from './cockpit.js';
import { createMining } from './mining.js';
import { makeStations, tickStations, UPGRADES } from './stations.js';
import { readSave, writeSave } from './save.js';

const BUILD = 'b30'; // bump on every change so the headset can show which version it's running
// ---------- seeded randomness + noise ----------
const params = new URLSearchParams(location.search);
const SEED = (() => { // ?seed= wins, then the last universe you were in (so a reload revisits it), then a new one; ?reroll forces new
  let s = Number(params.get('seed'));
  try { if (!s && !params.has('reroll')) s = Number(localStorage.getItem('nomad.seed')); } catch {}
  s ||= 1 + Math.floor(Math.random() * 99999);
  try { localStorage.setItem('nomad.seed', s); } catch {}
  return s;
})();
// the save says which star system you're in, so it's read before anything is built (save.js; ?fresh ignores it, ?sys=x,y picks one)
const saved = params.has('fresh') ? null : readSave(localStorage, SEED, UNIVERSE_VERSION);
const SYSTEM_INDEX = params.get('sys') ?? saved?.systemIndex ?? 0;
const rng = mulberry32(String(SYSTEM_INDEX) === '0' ? SEED : hash(SEED, 'sky', SYSTEM_INDEX)); // each system its own sky; home keeps the old one
const rand = (a, b) => a + (b - a) * rng();
const pick = arr => arr[Math.floor(rng() * arr.length)];

// ---------- retro look: ordered dither + colour quantise on every material ----------
const patched = new WeakSet(); // not userData: material.clone() copies userData but drops onBeforeCompile
function retro(mat) {
  if (!mat || patched.has(mat)) return;
  patched.add(mat);
  const before = mat.onBeforeCompile; // keep an earlier patch (the terrain's distance squash)
  mat.onBeforeCompile = (shader, r) => {
    before.call(mat, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `
      #include <dithering_fragment>
      {
        const float L = 10.0;
        float bayer[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
        ivec2 q = ivec2(mod(gl_FragCoord.xy, 4.0));
        float d = (bayer[q.y * 4 + q.x] / 16.0 - 0.5) / L;
        gl_FragColor.rgb = floor((gl_FragColor.rgb + d) * L + 0.5) / L;
      }`);
  };
  mat.needsUpdate = true;
}

// THREE.Color holds linear values; canvases want sRGB bytes
const _rgb = { r: 0, g: 0, b: 0 };
function putPx(data, i, c, a = 255) {
  c.getRGB(_rgb, THREE.SRGBColorSpace);
  data[i] = _rgb.r * 255; data[i + 1] = _rgb.g * 255; data[i + 2] = _rgb.b * 255; data[i + 3] = a;
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15; // highlights roll off instead of clipping
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap; // hard, pixel-y shadows fit the look and are cheap
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
const FB_SCALE = Number(params.get('fb')) || 0.75, TARGET_HZ = Number(params.get('hz')) || 72; // 0.55 made text mush; 72 Hz pays for the pixels
renderer.xr.setFramebufferScaleFactor(FB_SCALE);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
document.getElementById('info').insertAdjacentHTML('afterbegin', `<b>BUILD ${BUILD}</b> // `);
const perf = createPerf(renderer, () => ({ build: BUILD, seed: SEED, system: system.id, place, fbScale: FB_SCALE, ...(craft && { terrain: surface.stats, alt: +craft.alt.toFixed(1), mode: craft.mode }) }));
const perfEl = document.createElement('div');
document.getElementById('info').after(perfEl);
perfEl.style.cssText = 'position:absolute;bottom:12px;left:16px;color:#7fb8b0;font:12px monospace;pointer-events:none;white-space:pre';
setInterval(() => { perfEl.textContent = perf.text() + (craft ? `\n${surface.statsText()}  alt ${craft.alt.toFixed(1)} m  ${craft.mode}` : ''); }, 1000);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.02, 80000);
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- star system: data from universe.js, drawn in scaled space ----------
// Bodies live in real units (metres, star at the origin). Each frame they're drawn relative to the ship with the
// distance squashed logarithmically and the radius scaled by the same factor, which keeps true angular size and depth order.
const STAR_LOOK = { M: { color: 0xff8a5c, i: 2.2 }, K: { color: 0xffb877, i: 2.6 }, G: { color: 0xfff1d6, i: 3.0 },
  F: { color: 0xf4f6ff, i: 3.2 }, A: { color: 0xcfe0ff, i: 3.4 }, B: { color: 0x9fc0ff, i: 3.8 } };
const system = params.get('system') === 'test' ? testSystem(SEED) : generateSystem(SEED, SYSTEM_INDEX);
const star = { name: system.star.cls, ...STAR_LOOK[system.star.cls] };
// ?body=p2 or ?body=p2/m0 parks over (and lets you land on) that body instead
const startBody = system.bodies.find(b => params.get('body') && b.id === `${system.id}/${params.get('body')}`) ?? system.bodies.find(b => b.id === system.start.body);
const parkRadius = startBody.id === system.start.body ? system.start.orbitRadius : startBody.radius * 2.55;
let simTime = 0; // seconds since the system epoch (saved)
document.getElementById('info').insertAdjacentHTML('beforeend', `<br>SEED ${SEED} // ${system.name} (${star.name}) // parked over ${startBody.name}`);

const NEAR_REAL = 500, LOG_SCALE = 500; // drawn distance: real up to 500 m, then +500 m per factor of 10 (under 8 km out to 1e17 m); terrain squashes the same way
const MIN_ANGLE = 0.003;                   // far planets stay visible dots (about 2 px on the Quest) instead of vanishing
const scaledDist = d => d < NEAR_REAL ? d : NEAR_REAL + LOG_SCALE * Math.log10(d / NEAR_REAL);

// the ship is parked over the start body, on the side where the planet below shows a lit crescent to gibbous
const toSun0 = new THREE.Vector3(...positionAt(startBody, 0, system.bodies)).negate().normalize();
const parkDir = toSun0.clone().multiplyScalar(Math.cos(system.start.phase))
  .addScaledVector(new THREE.Vector3().crossVectors(toSun0, new THREE.Vector3(0, 1, 0)).normalize(), Math.sin(system.start.phase));
// the view frame: turn the system so the planet hangs below you, then roll so the sun sits as high as it can
let skyQ = (() => {
  const r = mulberry32(hash(system.id, 'view'));
  const down = new THREE.Vector3(r() * 1.2 - 0.6, -0.75, r() * 1.2 - 0.6).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(parkDir.clone().negate(), down);
  const flat = v => v.addScaledVector(down, -v.dot(down)).normalize();
  const s = flat(toSun0.clone().applyQuaternion(q)), y = flat(new THREE.Vector3(0, 1, 0));
  return y.lengthSq() > 0.5 ? new THREE.Quaternion().setFromUnitVectors(s, y).multiply(q) : q;
})();
const sunDir = new THREE.Vector3();
const skyFrame = new THREE.Group(); // fixed-direction backdrop (nebula, stars, the exotic), turned by skyQ every frame
scene.add(skyFrame);

const sun = new THREE.DirectionalLight(star.color, star.i);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05; // no acne on the cabin walls
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 130 });
scene.add(sun, sun.target);
const fill = new THREE.HemisphereLight(0x2a3a5a, 0x3a2418, 0.9); // faint bounce so the night side isn't pure black
scene.add(fill);

const glowTex = canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
function glow(color, size, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity }));
  s.scale.setScalar(size); return s;
}

const sunObj = new THREE.Group(), sunDisc = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: star.color }));
const sunGlow = glow(star.color, 1, 0.9);
sunObj.add(sunDisc, sunGlow);
scene.add(sunObj);

// nebula sky + stars
const neb = makeNoise(mulberry32(SEED + 7));
const nebHue = rand(0, 360);
const skyTex = canvasTex(512, 256, (g, w, h) => {
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const lon = x / w * Math.PI * 2, la = (y / h - 0.5) * Math.PI;
    const px = Math.cos(la) * Math.cos(lon) * 2, py = Math.sin(la) * 2, pz = Math.cos(la) * Math.sin(lon) * 2;
    const n = Math.max(0, neb(px, py, pz, 5) - 0.5) * 2.2;
    const m = Math.max(0, neb(px + 9, py, pz, 4) - 0.55) * 2;
    putPx(img.data, (y * w + x) * 4, new THREE.Color().setHSL((nebHue + m * 80) / 360, 0.7, Math.min(0.22, n * n * 0.6)));
  }
  g.putImageData(img, 0, 0);
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false }));
skyTex.magFilter = skyTex.minFilter = THREE.LinearFilter; // smooth nebula; the dither keeps it retro
sky.renderOrder = -2;
skyFrame.add(sky);
{
  const n = 5000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(65000);
    pos.set([v.x, v.y, v.z], i * 3);
    c.setHSL(pick([0.6, 0.08, 0.12, 0.0, 0.58]), rand(0.2, 0.6), rand(0.55, 1)).toArray(col, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
  stars.renderOrder = -1;
  skyFrame.add(stars);
}

// planets: the composition decides the look (and later, what you can mine there); ramps live in terrain.js
function ramp(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i];
    return new THREE.Color(ca).lerp(new THREE.Color(cb), (t - a) / (b - a));
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}
// solid bodies get their texture from the same terrain functions as the surface, built in a worker so loading never stalls
const texWorker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' }), texJobs = new Map();
texWorker.onmessage = ({ data }) => { texJobs.get(data.id)?.(data); texJobs.delete(data.id); };
function dataTex(bytes, w, h) {
  const t = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}
function makePlanet(body, texW) { // unit radius; placeSky scales it. Looks come only from the body's own seed.
  const kind = body.kind, r = mulberry32(body.seed), rand = (a, b) => a + (b - a) * r(), texH = texW / 2;
  const pn = makeNoise(r);
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  if (kind === 'gas') {
    const gasA = new THREE.Color().setHSL(rand(0, 1), rand(0.3, 0.6), 0.45), gasB = new THREE.Color().setHSL(rand(0, 1), 0.4, 0.75);
    mat.map = canvasTex(texW, texH, (g, w, h) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const lon = x / w * Math.PI * 2, la = (y / h - 0.5) * Math.PI;
        const px = Math.cos(la) * Math.cos(lon), py = Math.sin(la), pz = Math.cos(la) * Math.sin(lon);
        putPx(img.data, (y * w + x) * 4, gasA.clone().lerp(gasB, Math.sin(la * 9 + pn(px * 3, py * 3, pz * 3, 4) * 6) * 0.5 + 0.5));
      }
      g.putImageData(img, 0, 0);
    });
  } else {
    mat.color.set(ramp(KIND_RAMPS[kind], 0.6)); // until the worker's texture arrives
    texJobs.set(body.id, tx => {
      mat.map = dataTex(tx.rgba, tx.w, tx.h); mat.color.set(0xffffff);
      if (tx.glow) { mat.emissiveMap = dataTex(tx.glow, tx.w, tx.h); mat.emissive.set(0xffffff); mat.emissiveIntensity = 1.2; }
      mat.needsUpdate = true;
    });
    texWorker.postMessage({ type: 'texture', id: body.id, body: { kind, seed: body.seed, radius: body.radius, life: body.life }, w: texW });
  }
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat));
  if (kind === 'ocean') {
    const cloudTex = canvasTex(texW, texH, (g, w, h) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const lon = x / w * Math.PI * 2, la = (y / h - 0.5) * Math.PI;
        const n = pn(Math.cos(la) * Math.cos(lon) * 4 + 50, Math.sin(la) * 4, Math.cos(la) * Math.sin(lon) * 4, 5);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = n > 0.55 ? 220 : 0;
      }
      g.putImageData(img, 0, 0);
    });
    grp.add(new THREE.Mesh(new THREE.SphereGeometry(1.015, 48, 24),
      new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, depthWrite: false, roughness: 1 })));
    grp.add(new THREE.Mesh(new THREE.SphereGeometry(1.06, 48, 24),
      new THREE.MeshBasicMaterial({ color: 0x4d8dff, transparent: true, opacity: 0.12, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })));
  }
  if (body.rings) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.2, 64),
      new THREE.MeshStandardMaterial({ color: 0xcdb99a, side: THREE.DoubleSide, transparent: true, opacity: 0.6, roughness: 1 }));
    ring.rotation.x = Math.PI / 2 + rand(-0.3, 0.3);
    grp.add(ring);
  }
  // solid bodies stay in the planet frame (placeSky turns them with the view) so the sphere matches the terrain; gas giants spin
  // shortcut: solid planets don't rotate yet; add day/night rotation to both sphere and terrain together
  if (kind === 'gas') { grp.rotation.set(rand(-0.4, 0.4), rand(0, 6.28), rand(-0.4, 0.4)); grp.userData.spin = rand(0.002, 0.01); }
  return grp;
}
// the body you're parked over and its moons get the sharp textures; everything else is a dot from here
const bodyViews = system.bodies.map(b => {
  const g = makePlanet(b, b === startBody || b.parent === startBody.id ? 192 : 64);
  scene.add(g);
  return { b, g };
});

// ---------- ?surface: test flight from the parking orbit down to standing height, for PlanetSurface streaming ----------
// ?alt=N starts N metres up, ?speed=N is m/s across the ground once down, ?lodk=N is the chunk split distance in chunk sizes
// tileable 256px detail map (data, not colour): R fine grain and pebbles, G rock with cracks and strata, B soft blotches
function detailTexture() {
  const N = 256, r = mulberry32(90210), px = new Uint8Array(N * N * 4);
  const s = t => t * t * (3 - 2 * t);
  const periodic = P => { // value noise that wraps every P lattice cells, sampled in texture cells
    const v = Float32Array.from({ length: P * P }, r), at = (i, j) => v[((j % P + P) % P) * P + ((i % P + P) % P)];
    return (x, y) => { x *= P / N; y *= P / N; const X = Math.floor(x), Y = Math.floor(y), fx = s(x - X), fy = s(y - Y);
      return (at(X, Y) * (1 - fx) + at(X + 1, Y) * fx) * (1 - fy) + (at(X, Y + 1) * (1 - fx) + at(X + 1, Y + 1) * fx) * fy; };
  };
  const fbm = (base, oct) => { const ns = Array.from({ length: oct }, (_, k) => periodic(base << k));
    return (x, y) => ns.reduce((a, n, k) => a + n(x, y) / (1 << k), 0) / (2 - 1 / (1 << (oct - 1))); };
  const cells = P => { // tileable Voronoi: distance to nearest point and the edge measure F2 - F1, in cell units
    const pts = Float32Array.from({ length: P * P * 2 }, r);
    return (x, y) => { x *= P / N; y *= P / N; const X = Math.floor(x), Y = Math.floor(y); let f1 = 9, f2 = 9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const cx = ((X + i) % P + P) % P, cy = ((Y + j) % P + P) % P, k = (cy * P + cx) * 2;
        const d = Math.hypot(X + i + pts[k] - x, Y + j + pts[k + 1] - y);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      return [f1, f2 - f1]; };
  };
  const grain = fbm(16, 4), rockN = fbm(8, 4), blotch = fbm(4, 3), pebble = cells(40), crack = cells(10), warp = fbm(4, 2);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4, [pf] = pebble(x, y), [, edge] = crack(x, y);
    let g = 0.5 + (grain(x, y) - 0.5) * 1.6;
    if (pf < 0.28) g = 0.32 + 0.45 * rockN(x * 3, y * 3); // scattered pebbles, darker or lighter than the dust
    const strata = 0.5 + 0.5 * Math.sin((y + warp(x, y) * 40) / N * Math.PI * 2 * 12);
    let rk = 0.35 + (rockN(x, y) - 0.5) * 1.2 + strata * 0.25;
    rk *= 0.45 + 0.55 * Math.min(1, edge / 0.08); // dark cracks
    px[i] = Math.max(0, Math.min(255, g * 255)); px[i + 1] = Math.max(0, Math.min(255, rk * 255));
    px[i + 2] = Math.max(0, Math.min(255, (0.5 + (blotch(x, y) - 0.5) * 2) * 255)); px[i + 3] = 255;
  }
  const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
const terrainUniforms = { hazeColor: { value: new THREE.Color() }, hazeDensity: { value: 0 },
  detailMap: { value: null }, viewToPlanet: { value: new THREE.Matrix3() }, camMod: { value: new THREE.Vector3() }, planetUp: { value: new THREE.Vector3(0, 1, 0) },
  manualSun: { value: 0 }, sunDirW: { value: new THREE.Vector3() }, sunCol: { value: new THREE.Color() } }; // aboard, the sun light is off
terrainMat.onBeforeCompile = shader => {
  Object.assign(shader.uniforms, terrainUniforms);
  // the sky's distance squash, per vertex: directions stay true, depth stays precise. Haze uses the real distance.
  // Detail texture coordinates are planet-frame metres (camera position mod 26 m + offset), so the ground pattern never slides.
  shader.vertexShader = 'attribute float glow;\nuniform mat3 viewToPlanet;\nuniform vec3 camMod;\nvarying float vGlow;\nvarying float vDist;\nvarying vec3 vP;\nvarying vec3 vPN;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
    vGlow = glow;
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vP = camMod + viewToPlanet * wp.xyz; vPN = viewToPlanet * normalize(mat3(modelMatrix) * objectNormal);
    { float d = length(mvPosition.xyz); vDist = d;
      if (d > ${NEAR_REAL}.0) { mvPosition.xyz *= (${NEAR_REAL}.0 + ${LOG_SCALE}.0 * log2(d / ${NEAR_REAL}.0) * 0.30103) / d; gl_Position = projectionMatrix * mvPosition; } }`);
  shader.fragmentShader = 'uniform vec3 hazeColor;\nuniform float hazeDensity;\nuniform sampler2D detailMap;\nuniform vec3 planetUp;\nuniform float manualSun;\nuniform vec3 sunDirW;\nuniform vec3 sunCol;\nvarying float vGlow;\nvarying float vDist;\nvarying vec3 vP;\nvarying vec3 vPN;\n' + shader.fragmentShader
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  if (manualSun > 0.5) reflectedLight.directDiffuse += max(dot(normal, normalize((viewMatrix * vec4(sunDirW, 0.0)).xyz)), 0.0) * sunCol * BRDF_Lambert(material.diffuseColor);`)
    .replace('#include <color_fragment>', `#include <color_fragment>
  { // triplanar detail: 2 m grain or rock, 13 m blotches; fades out with distance so it never shimmers
    vec3 pn = normalize(vPN), w = pow(abs(pn), vec3(4.0)); w /= w.x + w.y + w.z;
    vec4 f = texture2D(detailMap, vP.yz * 0.5) * w.x + texture2D(detailMap, vP.zx * 0.5) * w.y + texture2D(detailMap, vP.xy * 0.5) * w.z;
    vec4 c = texture2D(detailMap, vP.yz * 0.0769) * w.x + texture2D(detailMap, vP.zx * 0.0769) * w.y + texture2D(detailMap, vP.xy * 0.0769) * w.z;
    float steep = 1.0 - smoothstep(0.72, 0.9, dot(pn, planetUp));
    float d = mix(f.r, f.g, steep) - 0.5 + (c.b - 0.5) * 0.7 + (c.g - 0.5) * 0.5 * steep;
    diffuseColor.rgb *= 1.0 + d * 0.75 * (1.0 - smoothstep(40.0, 260.0, vDist));
  }`)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vGlow * vec3(1.0, 0.3, 0.05) * 3.0;')
    .replace('#include <fog_fragment>', '#include <fog_fragment>\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, 1.0 - exp(-vDist * hazeDensity));');
};
terrainMat.customProgramCacheKey = () => 'terrain';
retro(terrainMat);
const surface = startBody.kind !== 'gas' ? new PlanetSurface(startBody, terrainMat, { splitK: Number(params.get('lodk')) || 1.1 }) : null;
// the craft: where the ship is over the start body. alt = metres above the ground under the ship's centre; ?alt=N starts there
const craft = surface && (() => {
  // land where the sun stands 17-31 degrees up, and travel with it 50 degrees off to one side: long shadows, readable relief
  const elev = 0.3 + mulberry32(hash(system.id, 'landing'))() * 0.25;
  const side = new THREE.Vector3().crossVectors(toSun0, new THREE.Vector3(0, 1, 0)).normalize();
  const dir = toSun0.clone().multiplyScalar(Math.sin(elev)).addScaledVector(side, Math.cos(elev));
  const sunFlat = toSun0.clone().addScaledVector(dir, -Math.sin(elev)).normalize();
  const fwd = sunFlat.clone().multiplyScalar(Math.cos(0.87)).addScaledVector(new THREE.Vector3().crossVectors(dir, sunFlat), Math.sin(0.87));
  if (startBody.kind === 'ocean') for (let k = 1; k < 3000 && surface.ground(dir) < 2; k++) { // walk a spiral (out to ~0.15 rad) to dry land
    const a = k * 2.4, r = 0.0028 * Math.sqrt(k);
    dir.copy(toSun0).multiplyScalar(Math.sin(elev)).addScaledVector(side, Math.cos(elev)).addScaledVector(sunFlat, r * Math.cos(a)).addScaledVector(new THREE.Vector3().crossVectors(dir, sunFlat), r * Math.sin(a)).normalize();
  }
  fwd.addScaledVector(dir, -fwd.dot(dir)).normalize();
  const parkAlt = parkRadius - startBody.radius, alt = Number(params.get('alt')) || parkAlt;
  return { dir, fwd, alt, parkAlt, minAlt: 0, mode: alt < parkAlt ? 'HOLD' : 'ORBIT', vel: new THREE.Vector3(), yawLatch: false, legG: [0, 0, 0, 0], groundAt: null,
    cam: [0, 0, 0], look: [0, 0, 0], q: new THREE.Quaternion(), qInv: new THREE.Quaternion(), m: new THREE.Matrix4(), right: new THREE.Vector3() };
})();
if (surface) { scene.add(surface.group); bodyViews.find(v => v.b === startBody).g.visible = false; terrainUniforms.detailMap.value = detailTexture(); }
// atmosphere: a sky dome over the stars plus haze on the terrain, both from the body's air (none on airless worlds)
const ATMOS_TINT = { 'N2-CO2': 0x5f8fe8, 'N2-O2': 0x5f8fe8, CO2: 0xd29a70, 'N2-CH4': 0xd99a4a, 'CO2-SO2': 0xe6cf8f, SO2: 0xcfb98a, trace: 0xa8896a };
const atmo = surface && (() => {
  const a = startBody.atmosphere, tint = ATMOS_TINT[a.composition];
  const uniforms = { sunDir: { value: sunDir }, tint: { value: new THREE.Color(tint ?? 0) }, sunset: { value: new THREE.Color(0xff7a3a) },
    strength: { value: 0 }, day: { value: 0 }, low: { value: 0 } };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50000, 32, 16), new THREE.ShaderMaterial({ uniforms, side: THREE.BackSide,
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 sunDir, tint, sunset; uniform float strength, day, low; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float horizon = pow(1.0 - max(d.y, 0.0), 4.0), s = max(dot(d, sunDir), 0.0);
        vec3 hz = mix(tint, sunset, low * 0.75);
        vec3 c = mix(tint * 0.5, hz * 1.15, horizon) + pow(s, 3.0) * 0.25 * hz + pow(s, 40.0) * vec3(1.0, 0.9, 0.75) * 0.6;
        gl_FragColor = vec4(c * day, (1.0 - exp(-strength * 3.0)) * day * (0.85 + 0.15 * horizon)); // thick air hides the stars by day
      }` }));
  dome.renderOrder = -1; dome.frustumCulled = false;
  scene.add(dome);
  return { uniforms, strength: tint ? Math.min(1, Math.log10(1 + a.pressure * 300) / Math.log10(301)) : 0, /* Mars-thin air still gives a dusky sky */ scaleHeight: 8000 * 9.81 / startBody.gravity };
})();
const _c = new THREE.Color(), _sunCol = new THREE.Color();
function updateAtmosphere() { // after placeSky, so sunDir is this frame's
  const u = atmo.uniforms, ss = THREE.MathUtils.smoothstep;
  const s = atmo.strength * Math.exp(-craft.alt / atmo.scaleHeight), day = ss(sunDir.y, -0.12, 0.2), low = 1 - ss(sunDir.y, 0, 0.35);
  u.strength.value = s; u.day.value = day; u.low.value = low;
  terrainUniforms.hazeColor.value.copy(u.tint.value).lerp(u.sunset.value, low * 0.75).multiplyScalar(day * 0.9);
  terrainUniforms.hazeDensity.value = s / 22000; // about 22 km of visibility at 1 bar
  // airless: hard black shadows with only a hint of fill; air: the sky lights the shade
  fill.color.setRGB(0.55, 0.58, 0.62).lerp(u.tint.value, 0.45 * s); // keep ground colours readable under tinted skies fill.groundColor.setRGB(0.12, 0.09, 0.07);
  fill.intensity = 0.3 + 0.8 * s * day; // airless still gets a little bounce off the ground, or shade turns pure black
  sun.intensity = star.i * (1 - 0.35 * s) * ss(sunDir.y, -0.03, 0.06);
  sun.color.copy(_sunCol.set(star.color)).lerp(_c.copy(u.sunset.value), low * s * 0.6);
  exotic.visible = s * day < 0.35;
  if (place === 'inside') { fill.color.setRGB(0.55, 0.5, 0.45); fill.intensity = 0.35; } // cabin bounce, not the sky
}

// ---------- flying the ship: arcade flight over the start body, autopilot land / takeoff / hold ----------
// Seated (head within 0.8 m of Station_Pilot): left stick flies forward/sideways, right stick Y climbs/descends,
// right stick X snap-yaws 30 degrees. Velocity eases toward the stick and stops on release. Console buttons 0/1/2 or
// window.nomad.autoLand() / takeoff() / hold() run the autopilot.
const SEA_FLOOR = startBody.kind === 'ocean' ? 0 : -Infinity;
// landing legs: four telescoping legs under the gear pods (Leg0..3_Upper/Lower/Foot in ship_v2.glb), each reaching its
// own ground, so the hull stays level on slopes (comfort). The ship rests where its shortest leg is LEG_NOM long, or
// higher if a hull sample (the FTL ring, nose, engine) would touch the ground.
const LEGS = [[-1.7, -2.0], [1.7, -2.0], [-1.7, 4.5], [1.7, 4.5]]; // [right, back] metres, under Gear_Pod0..3
const POD_Y = -3.38, FOOT_H = 0.35, LEG_NOM = 2.2, LEG_MAX = 5.0, LEG_STOW = 0.35;
const HULL = [[0, 0, -3.22], [0, 12.8, -5.22], [-3, 12.8, -4.3], [3, 12.8, -4.3], [0, -12, -2.2], [0, 16, -1.8]]; // [right, back, lowest y]
let seated = false, pilotPos = null;
const _look = new THREE.Vector3(), _fp = new THREE.Vector3(), _mv = new THREE.Vector3(), _ax = new THREE.Vector3(),
  _vb = new THREE.Vector3(), _hp = new THREE.Vector3(), _cv = new THREE.Vector3();
function craftCommand(cmd) {
  if (!craft) return;
  const m = craft.mode;
  ctl.thr = 0;
  if (cmd === 'land' && m !== 'LANDED') { craft.mode = 'DESCENT'; say('AUTOPILOT  //  DESCENT'); }
  if (cmd === 'takeoff') {
    const need = Math.min(95, Math.ceil(23 * startBody.gravity / 9.81)); // a climb to orbit burns about 21% per g
    if (power.fuel < need && m === 'LANDED') { say(`FUEL LOW  //  ASCENT NEEDS ${need}%`); beep(300); }
    else { craft.mode = 'ASCENT'; say('AUTOPILOT  //  ASCENT TO ORBIT'); }
  }
  if (cmd === 'hold' && m !== 'LANDED') { craft.mode = 'HOLD'; say('HOLDING POSITION'); }
}
function heightAboveGround(p) { // p in the view frame (three world), metres above the terrain
  _fp.copy(p).applyQuaternion(craft.qInv).add(_cv.fromArray(craft.cam));
  const d = _fp.length();
  return d - startBody.radius - surface.ground(_fp.divideScalar(d));
}
const landedOutside = () => craft?.mode === 'LANDED' && place === 'outside';
const _ray = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0), _ro = new THREE.Vector3();
function groundUnder(p) { // world y of the terrain you can see under p (the drawn mesh, not the finer analytic height)
  _ray.set(_ro.set(p.x, p.y + 40, p.z), _down); _ray.far = 200;
  const hit = _ray.intersectObjects(surface.drawn, false)[0];
  return hit ? hit.point.y : p.y - heightAboveGround(p);
}
let consoleButtons = []; // centres of Ctl_Button0..2: AUTO LAND, TAKEOFF, HOLD
const CONSOLE_CMDS = ['land', 'takeoff', 'hold'], _tp = new THREE.Vector3();
const research = { points: 0, done: {}, field: {} }; // RP; lab-analyzed and field-catalogued material types
// power and fuel, in %: the suit battery (drains outside, charges at the suit room cuff), ship fuel (refills slowly), warp fuel (made at the power panel)
const power = { suit: 100, fuel: 100, warp: 0, charging: false };
const mining = createMining({ scene, retro, nearLit: gloveLighting, keepCrisp: m => patched.add(m), say, beep, buzz, research });
// what the ship's screens read and change (stations.js)
const gameLog = []; // [simTime, text] for the computer's LOG page
const nav = { sel: null, lock: null, visited: [...new Set([0, SYSTEM_INDEX, ...(saved?.visited || [])].map(String))] }; // radar picks; systems you've been to
const warpCost = ly => Math.ceil(3 * ly); // % of the warp tank per light-year: a full tank goes about 33 ly
const G = { t: 0, system, mining, research, power, built: {}, job: null, refine: null, nav, seed: SEED, systemIndex: SYSTEM_INDEX, warpCost,
  // shortcut: research grows the radar range directly (~1-2 contacts at the start), not through an upgrade
  radarRange: () => 6 + Math.min(18, research.points / 8), engage: () => engageWarp(), analysis: { job: null, last: null }, galley: { t: 0, served: 0 },
  log: gameLog, airlock: { state: 'idle', kPa: 101.3, t: 0 },
  get simTime() { return simTime; }, get craft() { return craft; }, get place() { return place; },
  say, beep, craftCommand, cycle: () => airlockCycle(), save: () => saveGame(true),
  cabinLights: () => ctl.toggles[0]?.on ?? true, toggleLights: () => flipToggle(0), landCam: () => landCamOn, toggleLandCam: () => flipToggle(1) };
let stations = null;
let cargoAt = null; // Station_Cargo, where the suit unloads into the hold
let dockAt = null, chargerAt = null; // the pack dock and the suit charger cuff, in the suit room
let ftlMat = null, ftlBase = 1; // the warp core's glow: dim while broken, brighter with each part installed
const _hq = new THREE.Quaternion(), _hl = new THREE.Vector3();
function overShoulder(p) { // the grip beside or behind your head, above the chest: reaching for the backpack
  camera.getWorldPosition(_hp); camera.getWorldQuaternion(_hq);
  _hl.copy(p).sub(_hp).applyQuaternion(_hq.invert());
  return _hl.z > -0.03 && _hl.y > -0.35 && _hl.y < 0.25 && Math.abs(_hl.x) < 0.42;
}
// physical controls: grab the stick (right armrest) to fly forward/sideways, the throttle (left) to climb/descend.
// The stick springs back when you let go; the throttle stays put, with a centre detent that means hover.
const STICK_MAX = 0.35, STICK_LEAN = 0.175, THROTTLE_TRAVEL = 0.09; // rad, rad (grip's rest lean), m
const DESK_N = new THREE.Vector3(0, 0.883, 0.469); // the console desk's normal
const ctl = { buttons: [], stick: null, throttle: null, toggles: [], stickHand: null, throttleHand: null, fwd: 0, side: 0, thr: 0, grabZ: 0, grabThr: 0 };
const _cp2 = new THREE.Vector3(), _gp = new THREE.Vector3();
function setupControls(root) {
  const grab = (o, up) => o && { o, rest: o.quaternion.clone(), pos: o.position.clone(), pivot: o.getWorldPosition(new THREE.Vector3()), grip: o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, up, 0)) };
  ctl.stick = grab(root.getObjectByName('Ctl_Stick'), 0.2); ctl.throttle = grab(root.getObjectByName('Ctl_Throttle'), 0.105);
  ctl.toggles = [0, 1, 2, 3, 4, 5].map(i => root.getObjectByName('Ctl_Toggle' + i)).filter(Boolean).map(o => ({ o, x: o.rotation.x, on: true, at: centerOf(o) }));
  ctl.buttons = [0, 1, 2].map(i => root.getObjectByName('Ctl_Button' + i)).filter(Boolean).map(o => ({ o, pos: o.position.clone(), t: 1 }));
  ctl.stickHand = ctl.throttleHand = null; ctl.fwd = ctl.side = ctl.thr = 0; landCamOn = true; // a fresh interior has every switch on
}
function updateControls(dt) {
  if (!ctl.stick || !ctl.throttle) return;
  for (const h of Object.values(hands)) {
    const sq = !!h.source?.gamepad?.buttons[1]?.pressed; if (!h.grip) continue;
    h.grip.getWorldPosition(_gp);
    if (sq && !h.latch.ctl && place === 'inside' && !mining.holding(h)) {
      if (!ctl.stickHand && _gp.distanceTo(ctl.stick.grip) < 0.09) { ctl.stickHand = h; h.ctl = true; buzz(h, 0.6, 40); }
      else if (!ctl.throttleHand && _gp.distanceTo(ctl.throttle.grip) < 0.08) { ctl.throttleHand = h; h.ctl = true; ctl.grabZ = _gp.z; ctl.grabThr = ctl.thr; buzz(h, 0.6, 40); }
    }
    if (!sq) { if (ctl.stickHand === h) ctl.stickHand = null; if (ctl.throttleHand === h) { ctl.throttleHand = null; if (Math.abs(ctl.thr) < 0.12) ctl.thr = 0; } h.ctl = false; }
    h.latch.ctl = sq;
  }
  if (ctl.stickHand) { // lean of the hand from the pivot, minus the grip's own forward lean
    ctl.stickHand.grip.getWorldPosition(_gp); _cp2.copy(_gp).sub(ctl.stick.pivot);
    ctl.fwd = THREE.MathUtils.clamp(Math.atan2(-_cp2.z, _cp2.y) - STICK_LEAN, -STICK_MAX, STICK_MAX);
    ctl.side = THREE.MathUtils.clamp(Math.atan2(_cp2.x, _cp2.y), -STICK_MAX, STICK_MAX);
    if (Math.random() < 0.15) buzz(ctl.stickHand, 0.1 + 0.3 * Math.hypot(ctl.fwd, ctl.side) / STICK_MAX, 15);
  } else { const k = Math.exp(-dt * 12); ctl.fwd *= k; ctl.side *= k; }
  if (ctl.throttleHand) {
    ctl.throttleHand.grip.getWorldPosition(_gp);
    const before = ctl.thr;
    ctl.thr = THREE.MathUtils.clamp(ctl.grabThr - (_gp.z - ctl.grabZ) / THROTTLE_TRAVEL, -1, 1); // forward (-z) = climb
    if (Math.sign(before) !== Math.sign(ctl.thr)) buzz(ctl.throttleHand, 0.7, 25); // the detent
  }
  for (const b of ctl.buttons) { // pressed buttons sink 7 mm into the desk and spring back
    b.t += dt; const d = b.t < 0.15 ? 1 : Math.max(0, 1 - (b.t - 0.15) / 0.15);
    b.o.position.copy(b.pos).addScaledVector(DESK_N, -0.007 * d);
  }
  for (const t of ctl.toggles) t.o.rotation.x += ((t.on ? t.x : -t.x) - t.o.rotation.x) * Math.min(1, dt * 30); // levers swing over
  ctl.stick.o.quaternion.copy(ctl.stick.rest).multiply(_cq.setFromEuler(_ce.set(-ctl.fwd, 0, -ctl.side)));
  ctl.throttle.o.position.copy(ctl.throttle.pos); ctl.throttle.o.position.z -= ctl.thr * THROTTLE_TRAVEL;
}
const _cq = new THREE.Quaternion(), _ce = new THREE.Euler();
const TOGGLES = [() => shipLights.forEach(l => { if (!l.isPointLight) return; l.userData.base ??= l.intensity; l.intensity = l.userData.base * (ctl.toggles[0].on ? 1 : 0.2); }), // T0 cabin lights
  () => { landCamOn = ctl.toggles[1].on; }];                                                                                           // T1 landing camera
function flipToggle(i) { const t = ctl.toggles[i]; if (!t) return; t.on = !t.on; TOGGLES[i]?.(); beep(t.on ? 1200 : 700); }
function pokeConsole() { // fingertip on a console button or toggle, edge-triggered per hand
  const targets = [...consoleButtons.map((p, i) => ({ p, fire: () => { craftCommand(CONSOLE_CMDS[i]); if (ctl.buttons[i]) ctl.buttons[i].t = 0; } })),
    ...ctl.toggles.map((t, i) => ({ p: t.at, r: 0.025, fire: () => flipToggle(i) }))];
  for (const h of Object.values(hands)) {
    const tip = h.glove?.userData.tip; if (!tip) continue;
    tip.getWorldPosition(_tp);
    const i = targets.findIndex(t => t.p.distanceTo(_tp) < (t.r ?? 0.045));
    if (i >= 0 && h.latch.console !== i) { targets[i].fire(); beep(980); buzz(h, 0.6, 30); }
    if (i >= 0) h.latch.console = i; else if (targets.every(t => t.p.distanceTo(_tp) > 0.07)) h.latch.console = -1;
  }
}
function updateCraft(dt) {
  const s = craft, R = startBody.radius;
  s.right.crossVectors(s.fwd, s.dir);
  const gnd = d => Math.max(surface.ground(d), SEA_FLOOR); // on ocean worlds the water surface is the floor
  const g0 = gnd(s.dir);
  const at = (x, z) => gnd(_fp.copy(s.dir).multiplyScalar(R).addScaledVector(s.right, x).addScaledVector(s.fwd, -z).normalize()) - g0; // ground height there, relative
  s.groundAt = at;
  let rest = -Infinity;
  LEGS.forEach(([x, z], i) => { s.legG[i] = at(x, z); rest = Math.max(rest, s.legG[i] - POD_Y + LEG_NOM + FOOT_H); });
  for (const [x, z, bot] of HULL) rest = Math.max(rest, at(x, z) - bot + 0.3);
  s.minAlt = rest;
  // pilot input
  let ix = 0, iy = 0, iz = 0;
  camera.getWorldPosition(_hp);
  seated = place === 'inside' && !!pilotPos && (sitting || Math.hypot(_hp.x - pilotPos.x, _hp.z - pilotPos.z) < 0.8);
  if (seated) {
    const L = hands.left?.source?.gamepad, Rg = hands.right?.source?.gamepad, dz = v => (Math.abs(v) < 0.15 ? 0 : v);
    if (L) { ix = dz(L.axes[2] || 0); iz = dz(L.axes[3] || 0); }
    if (Rg) {
      iy = -dz(Rg.axes[3] || 0);
      const yx = Rg.axes[2] || 0;
      if (Math.abs(yx) > 0.7 && !s.yawLatch) { s.fwd.applyAxisAngle(s.dir, -Math.sign(yx) * Math.PI / 6); s.yawLatch = true; beep(660); }
      else if (Math.abs(yx) < 0.3) s.yawLatch = false;
    }
    const c1 = v => Math.max(-1, Math.min(1, v));
    ix = c1(ix + ctl.side / STICK_MAX); iz = c1(iz - ctl.fwd / STICK_MAX); iy = c1(iy + ctl.thr); // physical controls add on
    if (Math.abs(ix) < 0.05) ix = 0; if (Math.abs(iz) < 0.05) iz = 0;
    const firm = v => Math.abs(v) > 0.5; // a resting thumb or a half-leaned stick doesn't cancel the autopilot
    if (s.mode === 'LANDED' && iy > 0.5 && power.fuel < 5) { if (messageT <= 0) say('FUEL LOW  //  REFINE AT THE POWER PANEL'); }
    else if (s.mode === 'MANUAL' ? false : s.mode === 'LANDED' ? iy > 0.5 : firm(ix) || firm(iz) || firm(iy)) s.mode = 'MANUAL';
  }
  // target velocity in the ship frame (x right, y up, z back), faster the higher you are
  const h = s.alt - s.minAlt, hMax = Math.max(8, s.alt * 0.25), vMax = Math.max(10, s.alt * 0.5);
  _mv.set(0, 0, 0);
  if (s.mode === 'MANUAL') _mv.set(ix * hMax, iy * vMax, iz * hMax);
  else if (s.mode === 'DESCENT') _mv.y = -Math.max(1.5, h * (h > 2000 ? 0.25 : 0.15)); // about a minute from orbit, 1.5 m/s touchdown
  else if (s.mode === 'ASCENT') _mv.y = Math.max(3, s.alt * 0.25);
  if (s.mode === 'LANDED') s.vel.set(0, 0, 0); else s.vel.lerp(_mv, 1 - Math.exp(-dt * (s.mode === 'MANUAL' ? 1.5 : 3)));
  // fuel: engines burn against gravity; an empty tank still lands you on the reserve, and the reactor refills it (no stranding)
  if (['MANUAL', 'HOLD', 'ASCENT', 'DESCENT'].includes(s.mode)) power.fuel = Math.max(0, power.fuel - (0.12 + 0.25 * Math.min(1, s.vel.length() / 20)) * startBody.gravity / 9.81 * dt);
  if (power.fuel <= 0 && ['MANUAL', 'HOLD', 'ASCENT'].includes(s.mode)) { s.mode = 'DESCENT'; say('FUEL OUT  //  RESERVE LANDING'); beep(300); }
  // integrate: altitude, then travel along the sphere
  s.alt += s.vel.y * dt;
  const hor = Math.hypot(s.vel.x, s.vel.z) * dt;
  if (hor > 1e-6) {
    _mv.copy(s.right).multiplyScalar(s.vel.x).addScaledVector(s.fwd, -s.vel.z).normalize();
    const ang = hor / (R + g0 + s.alt);
    _ax.crossVectors(s.dir, _mv).normalize();
    s.dir.applyAxisAngle(_ax, ang).normalize(); s.fwd.applyAxisAngle(_ax, ang);
  }
  s.fwd.addScaledVector(s.dir, -s.fwd.dot(s.dir)).normalize();
  if (s.alt <= s.minAlt) {
    s.alt = s.minAlt; s.vel.y = Math.max(0, s.vel.y);
    if (s.mode === 'DESCENT' || (s.mode === 'MANUAL' && iy <= 0 && Math.hypot(s.vel.x, s.vel.z) < 1.5)) { s.mode = 'LANDED'; s.vel.set(0, 0, 0); say('TOUCHDOWN'); touchdown(); }
  }
  if (s.mode === 'LANDED') s.alt = s.minAlt;
  if (s.mode === 'ASCENT' && s.alt >= s.parkAlt) { s.alt = s.parkAlt; s.mode = 'ORBIT'; s.vel.set(0, 0, 0); say('PARKING ORBIT'); }
  s.alt = Math.min(s.alt, s.parkAlt * 1.5);
  // view frame: radial up, heading -z. The ship stays level (comfort); the canopy faces up, so a belly camera shows the ground
  const r = R + g0 + s.alt;
  s.cam[0] = s.dir.x * r; s.cam[1] = s.dir.y * r; s.cam[2] = s.dir.z * r;
  s.qInv.setFromRotationMatrix(s.m.makeBasis(s.right, s.dir, _vb.copy(s.fwd).negate())); s.q.copy(s.qInv).invert();
  skyQ = s.q;
  terrainUniforms.viewToPlanet.value.setFromMatrix4(s.m); terrainUniforms.planetUp.value.copy(s.dir);
  terrainUniforms.camMod.value.set(...s.cam.map(c => (c % 26 + 26) % 26)); // 26 m = both detail tiles (2 m, 13 m) repeat
  (feedOn ? landCam : camera).getWorldDirection(_look).applyQuaternion(s.qInv); // cull to whichever view shows the ground
  surface.update(s.cam, s.q, _look.toArray(s.look));
}

// belly camera on the right console screen: the canopy faces up, so this is how you watch the ground while flying.
// Renders only while you're on the bridge: 10 Hz in flight, 2 Hz parked or landed, 320x200, no ship.
const landCam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 80000);
const landRT = new THREE.WebGLRenderTarget(320, 200);
landRT.texture.colorSpace = THREE.SRGBColorSpace;
let landT = 0, feedOn = false, landCamOn = true;
function updateLandCam(dt) {
  const show = !!(craft && cockpit && landCamOn && place === 'inside' && camera.getWorldPosition(_hp).z < -6.5); // bridge: Blender y > 6.5
  if (show !== feedOn) { cockpit?.setFeed('Bridge_Screen2', show ? landRT.texture : null); feedOn = show; }
  if (!show || (landT -= dt) > 0) return;
  landT = craft.mode === 'ORBIT' || craft.mode === 'LANDED' ? 0.5 : 0.1;
  const down = 25 + 65 * THREE.MathUtils.smoothstep(craft.alt - craft.minAlt, 3000, 200000); // straight down from orbit
  landCam.position.set(0, -2.6, -6); landCam.rotation.set(-THREE.MathUtils.degToRad(down), 0, 0, 'YXZ');
  landCam.updateMatrixWorld();
  const xr = renderer.xr.enabled;
  ship.visible = false; renderer.xr.enabled = false;
  renderer.setRenderTarget(landRT); renderer.render(scene, landCam); renderer.setRenderTarget(null);
  renderer.xr.enabled = xr; ship.visible = true;
}

const _ship = [0, 0, 0], _body = [0, 0, 0], _rel = new THREE.Vector3();
function placeScaled(obj, rel, radius, minAngle) { // rel: real offset from the ship, already in the view frame
  const d = rel.length(), sd = scaledDist(d);
  obj.position.copy(rel).multiplyScalar(sd / d);
  return Math.max(radius * sd / d, sd * minAngle);
}
function placeSky() { // runs every frame: the subtraction happens in doubles, so far-apart bodies don't jitter
  positionAt(startBody, simTime, system.bodies, _ship);
  if (craft) for (let k = 0; k < 3; k++) _ship[k] += craft.cam[k];
  else { _ship[0] += parkDir.x * parkRadius; _ship[1] += parkDir.y * parkRadius; _ship[2] += parkDir.z * parkRadius; }
  for (const v of bodyViews) {
    positionAt(v.b, simTime, system.bodies, _body);
    _rel.set(_body[0] - _ship[0], _body[1] - _ship[1], _body[2] - _ship[2]).applyQuaternion(skyQ);
    v.g.scale.setScalar(placeScaled(v.g, _rel, v.b.radius, v.b === startBody ? 0 : MIN_ANGLE));
    if (v.b.kind !== 'gas') v.g.quaternion.copy(skyQ);
  }
  _rel.set(-_ship[0], -_ship[1], -_ship[2]).applyQuaternion(skyQ);
  sunDir.copy(_rel).normalize();
  sunDisc.scale.setScalar(placeScaled(sunObj, _rel, system.star.radius, MIN_ANGLE));
  sunGlow.scale.setScalar(sunObj.position.length() * 0.45);
  sun.position.copy(sunDir).multiplyScalar(60);
  skyFrame.quaternion.copy(skyQ);
}
placeSky();

// cockpit displays read the same doubles placeSky just used
let cockpit = null;
const _cb = [0, 0, 0], _sunRel = new THREE.Vector3(), _player = new THREE.Vector3();
const relOf = b => { positionAt(b, simTime, system.bodies, _cb); return new THREE.Vector3(_cb[0] - _ship[0], _cb[1] - _ship[1], _cb[2] - _ship[2]).applyQuaternion(skyQ); };
function updateCockpit(dt) {
  _sunRel.set(-_ship[0], -_ship[1], -_ship[2]).applyQuaternion(skyQ);
  cockpit.update(dt, { system, startBody, simTime, relOf, sunRel: _sunRel, place, player: camera.getWorldPosition(_player),
    mode: craft ? craft.mode : 'ORBIT', alt: craft ? craft.alt - craft.minAlt : parkRadius - startBody.radius,
    vs: craft ? craft.vel.y : 0, gs: craft ? Math.hypot(craft.vel.x, craft.vel.z) : 0, hold: mining.store.total(), suit: mining.inv.total(), fuel: power.fuel,
    lock: nav.lock && `${nav.lock.name} ${nav.lock.dist.toFixed(1)}LY` });
}

// one distant exotic object in the sky, light-years away (?exotic= overrides the kind)
const exoticKind = params.get('exotic') || system.sky.exotic.kind;
const exotic = new THREE.Group();
{
  exotic.position.fromArray(system.sky.exotic.dir).multiplyScalar(22000);
  exotic.lookAt(0, 0, 0);
  const add = THREE.AdditiveBlending;
  if (exoticKind === 'blackhole') {
    const diskTex = canvasTex(128, 128, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,250,230,1)'); gr.addColorStop(0.3, 'rgba(255,170,60,0.9)');
      gr.addColorStop(0.7, 'rgba(160,40,10,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    const disk = new THREE.Mesh(new THREE.RingGeometry(700, 2600, 96, 1),
      new THREE.MeshBasicMaterial({ map: diskTex, side: THREE.DoubleSide, transparent: true, blending: add, depthWrite: false }));
    // RingGeometry UVs are planar, so the radial gradient maps straight onto it
    disk.rotation.x = Math.PI / 2 - 0.25; exotic.add(disk);
    exotic.add(new THREE.Mesh(new THREE.SphereGeometry(620, 48, 24), new THREE.MeshBasicMaterial({ color: 0x000000 })));
    const photon = new THREE.Mesh(new THREE.RingGeometry(630, 680, 96),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, blending: add, depthWrite: false, side: THREE.DoubleSide }));
    exotic.add(photon);
    exotic.userData.disk = disk;
  } else {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(exoticKind === 'quasar' ? 300 : 90, 2),
      new THREE.MeshBasicMaterial({ color: 0xd9ecff }));
    exotic.add(core, glow(exoticKind === 'quasar' ? 0xb0c8ff : 0x9fd0ff, exoticKind === 'quasar' ? 9000 : 2600));
    if (exoticKind === 'pulsar' || exoticKind === 'quasar') {
      const jetLen = exoticKind === 'quasar' ? 30000 : 9000;
      const beams = new THREE.Group();
      for (const s of [1, -1]) {
        const beam = new THREE.Mesh(new THREE.ConeGeometry(exoticKind === 'quasar' ? 500 : 600, jetLen, 16, 1, true),
          new THREE.MeshBasicMaterial({ color: exoticKind === 'quasar' ? 0x9fb8ff : 0xcfe6ff, transparent: true,
            opacity: 0.35, blending: add, depthWrite: false, side: THREE.DoubleSide }));
        beam.position.y = s * jetLen / 2; beam.rotation.x = s > 0 ? Math.PI : 0;
        beams.add(beam);
      }
      beams.rotation.z = exoticKind === 'quasar' ? 0.3 : 0.9;
      exotic.add(beams); exotic.userData.beams = beams;
    }
    if (exoticKind === 'quasar') {
      const disk = new THREE.Mesh(new THREE.RingGeometry(400, 3500, 96),
        new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.45, blending: add, side: THREE.DoubleSide, depthWrite: false }));
      disk.rotation.x = Math.PI / 2 + 0.3; exotic.add(disk);
    }
    exotic.userData.core = core;
  }
  skyFrame.add(exotic);
}

// ---------- the ship: exterior and interior are separate models, and only one is loaded at a time ----------
// Going through the airlock disposes one and loads the other, so the headset never draws (or holds) both.
const shipColliders = []; // per mesh of the loaded model: world AABB + world-space triangles, for hand/head contact
let hatch = new THREE.Vector3(-4.07, -0.2, 2.75);          // exterior hatch (read from the model)
const tetherClip = new THREE.Vector3(-4.15, -0.2, 4.0);   // where the tether is clipped on, by the hatch
let interiorDoor = new THREE.Vector3(-3.88, -0.2, 2.75), interiorSpawn = new THREE.Vector3(0, -1.2, 2.75);
let place = 'outside';            // 'outside' = exterior loaded, zero-g EVA; 'inside' = interior loaded, artificial gravity
const DECK_Y = -1.2, EYE_HEIGHT = 1.55;
let innerDoor = null; // the suit room's airlock door, which slides up into the ceiling when you come close
const hullTex = (base, line, rep) => { // 4x4 plates per tile (some merged 2x1): seams, rivets, the odd cover, grime streaks
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const P = 64, used = new Set();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      if (used.has(x + y * 4)) continue;
      const wide = x < 3 && !used.has(x + 1 + y * 4) && rng() < 0.35, pw = wide ? 2 * P : P, X = x * P, Y = y * P;
      used.add(x + y * 4); if (wide) used.add(x + 1 + y * 4);
      g.fillStyle = rng() < 0.5 ? `rgba(0,0,0,${rng() * 0.08})` : `rgba(255,255,255,${rng() * 0.06})`; g.fillRect(X, Y, pw, P);
      g.fillStyle = line; g.fillRect(X, Y, pw, 2); g.fillRect(X, Y, 2, P);                                      // seam
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(X, Y + 2, pw, 1); g.fillRect(X + 2, Y, 1, P);        // lip
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let i = 8; i < pw; i += 12) g.fillRect(X + i, Y + 6, 2, 2);
      for (let j = 8; j < P; j += 12) g.fillRect(X + 6, Y + j, 2, 2);
      if (rng() < 0.15) { g.strokeStyle = line; g.lineWidth = 1.5; g.strokeRect(X + 18.5, Y + 20.5, 26, 20); }
    }
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(40,36,30,${rng() * 0.06})`; g.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 10 + rng() * 50); }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${rng() * 0.08})`; g.fillRect(rng() * w, rng() * h, 1, 1); }
  });
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; // no moire in VR
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); return t;
};
const grateTex = () => { // deck grating
  const t = canvasTex(32, 32, (g, w, h) => {
    g.fillStyle = '#2a2c30'; g.fillRect(0, 0, w, h); g.fillStyle = '#121315';
    for (let y = 2; y < h; y += 8) for (let x = 2; x < w; x += 4) g.fillRect(x, y, 2, 5);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8); return t;
};
const ship = new THREE.Group();
scene.add(ship);
const shipLights = [];
const gltfLoader = new GLTFLoader();
const loadModel = url => new Promise((res, rej) => gltfLoader.load(url, g => res(g.scene), undefined, rej));
const centerOf = o => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
function disposeShip() {
  if (feedOn) { cockpit?.setFeed('Bridge_Screen2', null); feedOn = false; } // the landing camera's target is reused, never disposed
  ship.traverse(o => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [].concat(o.material)) { for (const k in m) if (m[k]?.isTexture) m[k].dispose(); m.dispose(); }
  });
  ship.clear();
  for (const l of shipLights) { scene.remove(l, l.target); l.dispose?.(); }
  shipLights.length = 0; shipColliders.length = 0; innerDoor = null; cockpit = null; stations = null; outerDoor = null; airlockLight = null; consoleButtons = []; cargoAt = dockAt = chargerAt = null;
}
function buildColliders(root) {
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh || /^(Ctl_|Leg\d)/.test(o.name) || /^Ctl_/.test(o.parent?.name)) return; // controls you grab and poke, and the moving legs, don't push your hands away
    const pos = o.geometry.attributes.position, idx = o.geometry.index, tris = [];
    const v = i => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
    for (let k = 0, n = idx ? idx.count : pos.count; k < n; k += 3)
      tris.push(idx ? new THREE.Triangle(v(idx.getX(k)), v(idx.getX(k + 1)), v(idx.getX(k + 2))) : new THREE.Triangle(v(k), v(k + 1), v(k + 2)));
    shipColliders.push({ box: new THREE.Box3().setFromObject(o), tris, name: o.name });
  });
}
// Draw calls: everything static becomes one mesh per material (~200 parts -> ~20 draws). Parts the game moves or looks up
// by name stay separate. Colliders are built from the original parts first, so hand and head contact is unchanged.
const KEEP_SEPARATE = /^(Leg\d|Hatch_Airlock|Handle_Airlock|Floodlight|NavLight|Ctl_|Airlock_Inner|Airlock_OuterDoor|Bridge_.*Screen|Reactor_Core)/;
function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const groups = new Map(), drop = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== root; p = p.parent) if (KEEP_SEPARATE.test(p.name)) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld); // the ship group sits at the origin, unrotated
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    if (!groups.has(o.material.uuid)) groups.set(o.material.uuid, { mat: o.material, geos: [] });
    groups.get(o.material.uuid).geos.push(g); drop.push(o);
  });
  for (const o of drop) { o.parent.remove(o); o.geometry.dispose(); }
  for (const { mat, geos } of groups.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat); m.name = 'merged_' + mat.name;
    m.castShadow = !/Glass/.test(mat.name); m.receiveShadow = true; root.add(m); geos.forEach(g => g.dispose());
  }
}
async function loadExterior() {
  const root = await loadModel('ship_v2.glb');
  disposeShip(); ship.add(root);
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const m = o.material;
    if (m.name === 'Hull' && !m.map) { m.map = hullTex('#d8d8d2', '#8a8a86', 3); m.color.set(0xffffff).multiplyScalar(0.62); }
    if (m.name === 'HullPlate' && !m.map) { m.map = hullTex('#c4c6c2', '#7a7c7a', 2); m.color.set(0xffffff).multiplyScalar(0.5); }
    if (m.name === 'DarkMetal' && !m.map) { m.map = hullTex('#3a3a40', '#18181c', 2); m.color.set(0xffffff).multiplyScalar(0.35); }
    if (m.name === 'SolarCell' && !m.map) m.map = hullTex('#1a2a6a', '#8090c0', 3); // UVs are metres/6, so ~0.5 m cells
  });
  buildColliders(root);
  root.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'Hatch_Airlock') hatch = centerOf(o);
    if (o.name === 'Handle_Airlock0') tetherClip.copy(centerOf(o));
    if (o.name.startsWith('NavLight')) o.userData.blink = true;
    const fl = o.name.match(/^Floodlight_(Front|Top|Belly)(_1)?$/); // a two-material lamp loads as meshes _1 and _2: one light, not two
    if (fl) {
      const s = new THREE.SpotLight(0xfff0d8, 60, 45, 0.7, 0.5, 1.5);
      s.position.copy(centerOf(o));
      const dir = fl[1] === 'Front' ? new THREE.Vector3(0, -0.4, -1) : fl[1] === 'Belly' ? new THREE.Vector3(0, -1, -0.3) : new THREE.Vector3(0.3, 1, 0.4);
      s.target.position.copy(s.position).add(dir.multiplyScalar(10));
      scene.add(s, s.target); shipLights.push(s);
    }
  });
  root.traverse(o => { if (o.material) [].concat(o.material).forEach(retro); });
  legParts = [0, 1, 2, 3].map(i => ({ upper: root.getObjectByName(`Leg${i}_Upper`), lower: root.getObjectByName(`Leg${i}_Lower`), foot: root.getObjectByName(`Leg${i}_Foot`) }))
    .filter(p => p.upper && p.lower && p.foot);
  for (const p of legParts) p.y0 = p.lower.position.y; // the rod's pivot under the pod (the model may be exported with the legs posed)
  gearDown = craft?.mode === 'LANDED'; ladder.len = 0; ship.add(ladder.group); // no GEAR DOWN call-out for a ship that's already down
  mergeStatic(root);
  sun.visible = true;
}
async function loadInterior() {
  const root = await loadModel('interior.glb');
  disposeShip(); ship.add(root);
  root.traverse(o => {
    if (o.isMesh && o.material.name === 'Int_Floor' && !o.material.map) { o.material.map = grateTex(); o.material.color.set(0xffffff); }
  });
  buildColliders(root);
  const pilot = root.getObjectByName('Station_Pilot');
  pilotPos = pilot ? pilot.getWorldPosition(new THREE.Vector3()) : null;
  cargoAt = root.getObjectByName('Station_Cargo')?.getWorldPosition(new THREE.Vector3()) ?? null;
  const mount = root.getObjectByName('PackDock_Mount');
  dockAt = mount ? { pos: mount.getWorldPosition(new THREE.Vector3()), face: new THREE.Vector3(1, 0, 0) } : null; // the pack faces into the room
  chargerAt = root.getObjectByName('SuitCharger_Point')?.getWorldPosition(new THREE.Vector3()) ?? null;
  setupControls(root);
  consoleButtons = ['Ctl_Button0', 'Ctl_Button1', 'Ctl_Button2'].map(n => root.getObjectByName(n)).filter(Boolean).map(o => centerOf(o));
  if (pilot) {
    cockpit = makeCockpitScreens(root, pilot.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.75, 0)));
    cockpit.materials.forEach(m => patched.add(m)); // crisp text, no dither
    stations = makeStations(root, G, pilot.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.75, 0)));
    stations.screens.forEach(s => patched.add(s.quad.material));
  }
  // a handful of real lights (no shadows) at the ceiling light markers, plus the reactor's glow
  const ROOM_LIGHT = { Light_Bridge: 0xd8e6ff, Light_Hab: 0xffdcb4, Light_Lab: 0xf0f6ff, Light_SuitRoom: 0xe8f0f0, Light_Cargo: 0xfff0d8, Light_Engineering: 0xffc890 }; // cool bridge, warm hab, amber engines
  for (const n of Object.keys(ROOM_LIGHT)) {
    const m = root.getObjectByName(n); if (!m) continue;
    const L = new THREE.PointLight(ROOM_LIGHT[n], 4.5, 7.5, 1.4); m.getWorldPosition(L.position); scene.add(L); shipLights.push(L);
  }
  const core = root.getObjectByName('Reactor_Core');
  if (core) { const L = new THREE.PointLight(0xff8a30, 4, 5, 1.2); L.position.copy(centerOf(core)); scene.add(L); shipLights.push(L); }
  const door = root.getObjectByName('Airlock_OuterDoor'); if (door) interiorDoor = centerOf(door);
  outerDoor = door ? { o: door, y: door.position.y, open: 0, colliders: shipColliders.filter(c => c.name === door.name || door.getObjectByName(c.name)) } : null;
  airlockLight = new THREE.PointLight(0x5ee08a, 2.5, 4, 1.5); airlockLight.position.set(-3.0, 0.75, 2.75); scene.add(airlockLight); shipLights.push(airlockLight);
  const parts = ['Airlock_InnerDoor', 'Airlock_InnerDoorStripe', 'Airlock_InnerWindow'].map(n => root.getObjectByName(n)).filter(Boolean);
  innerDoor = parts.length ? { parts, base: parts.map(p => p.position.y), center: centerOf(parts[0]), open: 0,
    colliders: shipColliders.filter(c => parts.some(p => p.getObjectByName(c.name) || p.name === c.name)) } : null;
  const spawn = root.getObjectByName('Player_Spawn'); if (spawn) spawn.getWorldPosition(interiorSpawn);
  root.traverse(o => { if (o.material) [].concat(o.material).forEach(retro); });
  mergeStatic(root);
  sun.visible = true; // the shell is watertight and casts shadows, so the sun only gets in through the canopy
  ftlMat = null; root.traverse(o => { if (o.material?.name === 'Int_FTLCore') ftlMat = o.material; }); ftlBase = ftlMat?.emissiveIntensity ?? 1;
  switches.forEach((on, i) => { if (ctl.toggles[i] && ctl.toggles[i].on !== on) { ctl.toggles[i].on = on; TOGGLES[i]?.(); } }); // the switches as you left them
}
// ---------- save system v1 (save.js): one save per seed; ?fresh ignores it ----------
let switches = [true, true]; // cabin lights, landing cam: kept while the interior is unloaded
if (saved) {
  simTime = saved.simTime || 0;
  mining.restore(saved);
  Object.assign(research, saved.research);
  for (const id of saved.built || []) { const u = UPGRADES.find(x => x.id === id); if (u) { u.apply(G); G.built[id] = true; } }
  if (saved.job) G.job = { u: UPGRADES.find(x => x.id === saved.job.id), t: saved.job.t }; if (!G.job?.u) G.job = null;
  G.analysis.job = saved.analysis || null;
  G.refine = saved.refine || null;
  switches = saved.switches || switches;
  Object.assign(power, saved.power);
  if (craft && saved.craft && saved.body === startBody.id) {
    craft.dir.fromArray(saved.craft.dir); craft.fwd.fromArray(saved.craft.fwd); craft.alt = saved.craft.alt; craft.mode = saved.craft.mode;
  }
  gameLog.push(...(saved.log || []));
}
function saveGame(manual) { // shortcut: the airlock always loads idle and pressurised, a mid-cycle save drops the cycle
  if (ctl.toggles.length) switches = ctl.toggles.slice(0, 2).map(t => t.on);
  const gone = warp.committed; // past the point of no return: the save already describes the arrival
  const ok = writeSave(localStorage, SEED, { seed: SEED, universe: UNIVERSE_VERSION, build: BUILD, simTime, body: gone ? null : startBody.id,
    systemIndex: gone ? warp.target.index : SYSTEM_INDEX, visited: nav.visited, warpArrival: gone ? { from: system.name, ly: warp.target.dist } : undefined,
    place: place === 'inside' ? 'inside' : 'outside', ...mining.save(), research, built: Object.keys(G.built),
    job: G.job && { id: G.job.u.id, t: G.job.t }, analysis: G.analysis.job, refine: G.refine, switches, power: { suit: power.suit, fuel: power.fuel, warp: power.warp }, log: gameLog.slice(-20),
    craft: craft && !gone ? { dir: craft.dir.toArray(), fwd: craft.fwd.toArray(), alt: craft.alt, mode: craft.mode } : null });
  if (manual) { say(ok ? 'GAME SAVED' : 'SAVE FAILED  //  STORAGE FULL'); beep(ok ? 1200 : 300); }
  return ok;
}
setInterval(() => saveGame(false), 60000);
addEventListener('pagehide', () => saveGame(false)); // the Quest browser closing
const firstLoad = params.has('inside') || saved?.place === 'inside' ? loadInterior().then(() => { place = 'inside'; }) : loadExterior();

// ---------- player: suit, hands, jets, wrist screen ----------
const suit = { jetPower: 3, headlight: true, stabilizer: true, screenArm: 'left' };
const JET_LEVELS = [0.6, 1.2, 2.0, 3.0, 4.5];
const vel = new THREE.Vector3();
let message = '', messageT = 0;

const headlight = new THREE.SpotLight(0xf6f2e6, 80, 60, 0.45, 0.45, 1.6);
headlight.position.set(0.1, 0.05, 0);
headlight.target.position.set(0, -0.05, -1);
camera.add(headlight, headlight.target);

// suited arm + rigged glove from Blender (glove.glb is a right arm; the left one is mirrored).
// Its frame matches the hand holder: -Z = pointing, +Y = top/thumb, palm faces -X, forearm runs along +Z.
// Bones: hand (root, at the wrist) -> forearm (swings from the wrist toward an estimated elbow), fingers, thumb.
const gloveTemplate = new Promise((res, rej) => new GLTFLoader().load('glove.glb', g => res(g.scene), undefined, rej));
const CURL_AXIS = new THREE.Vector3(0, 1, 0), SPLAY_AXIS = new THREE.Vector3(1, 0, 0), THUMB_AXIS = new THREE.Vector3(-1, 0, -0.3).normalize();
const JOINT_GAIN = [1, 1.15, 0.85];
const FINGER = { index: { gain: 1, splay: 0.09 }, middle: { gain: 1, splay: 0 }, ring: { gain: 1.05, splay: -0.07 }, pinky: { gain: 1.12, splay: -0.16 } };
const coreMat = new THREE.MeshBasicMaterial({ color: 0xe8fbff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const plumeMat = new THREE.MeshBasicMaterial({ color: 0x4fb8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const coreGeo = new THREE.ConeGeometry(0.009, 0.08, 12, 1, true).translate(0, 0.04, 0);   // base at the nozzle, along +Y
const plumeGeo = new THREE.ConeGeometry(0.016, 0.24, 12, 1, true).translate(0, 0.12, 0);
const toBoneFrame = (bone, v) => v.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
// the helmet lamp sits ~0.4 m from your hands, where its falloff makes them ~100x brighter than the hull 10 m out (pure
// white). On the gloves, any spot light closer than 6 m lights them as if it were 6 m away.
const GLOVE_LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace('getSpotLightInfo( spotLight, geometryPosition, directLight );',
  'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= pow( min( length( spotLight.position - geometryPosition ) / 6.0, 1.0 ), 1.6 );');
function gloveLighting(m) {
  m.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', GLOVE_LIGHTS); };
  m.customProgramCacheKey = () => 'glove'; // retro()'s wrapper reads the same everywhere, so keep these programs apart
}
async function makeGlove(side) {
  const model = SkeletonUtils.clone(await gloveTemplate);
  model.updateMatrixWorld(true);
  const joints = [];
  let heat = null, display = null, forearm = null, handBone = null;
  model.traverse(o => {
    if (o.isMesh) {
      o.frustumCulled = false;
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); // per-arm heat glow
      [].concat(o.material).forEach(m => { gloveLighting(m); retro(m); if (m.name === 'JetHeat') heat = m; });
    }
    if (!o.isBone) return;
    if (o.name === 'hand') handBone = o;
    if (o.name === 'forearm') forearm = { bone: o, rest: o.quaternion.clone(), restDir: new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion) };
    const m = o.name.match(/^(index|middle|ring|pinky|thumb)_(\d)$/);
    if (!m) return;
    // curl/splay axes are fixed in hand space; express them in each bone's rest frame once
    joints.push({ bone: o, finger: m[1], seg: +m[2], gain: JOINT_GAIN[m[2] - 1], rest: o.quaternion.clone(),
      curl: toBoneFrame(o, m[1] === 'thumb' ? THUMB_AXIS : CURL_AXIS), splay: toBoneFrame(o, SPLAY_AXIS) });
  });
  display = model.getObjectByName('ArmDisplay'); // multi-material, so it's a group of meshes
  model.scale.x = side === 'left' ? -1 : 1;
  const holder = new THREE.Group(); holder.add(model);
  const jet = model.getObjectByName('Jet_Anchor'); // its +Y is the exhaust direction, origin at the nozzle exit
  const flame = new THREE.Group();
  flame.add(new THREE.Mesh(plumeGeo, plumeMat), new THREE.Mesh(coreGeo, coreMat), glow(0x9fdcff, 0.06, 0.9));
  flame.visible = false;
  jet?.add(flame);
  holder.userData = { side, joints, flame, jet, heat, display, forearm, handBone, heatLevel: 0,
    screen: model.getObjectByName('ArmScreen_Anchor'), tip: model.getObjectByName('index_tip') };
  return holder;
}
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
function poseFingers(h, gp) { // trigger curls the index, grip curls the rest (pinky first), open hand splays, thumb drops on a button
  const trig = gp.buttons[0]?.value || 0, sq = mining.holding(h) || h.ctl ? 0.8 : gp.buttons[1]?.value || 0; // fingers stay wrapped round the tool or control grip
  const thumbDown = [3, 4, 5].some(i => gp.buttons[i]?.touched);
  for (const j of h.glove.userData.joints) {
    let a, s = 0;
    if (j.finger === 'index') { a = 0.12 + trig * 1.05; s = FINGER.index.splay * (1 - trig); }
    else if (j.finger === 'thumb') a = (thumbDown ? 0.5 : 0.12) + sq * 0.3;
    else {
      const f = FINGER[j.finger], k = Math.min(1, sq * (j.finger === 'pinky' ? 1.25 : j.finger === 'ring' ? 1.12 : 1));
      a = (0.22 + k * 1.15) * f.gain; s = f.splay * (1 - sq);
    }
    j.bone.quaternion.copy(j.rest).multiply(qa.setFromAxisAngle(j.curl, a * j.gain));
    if (j.seg === 1 && s) j.bone.quaternion.multiply(qb.setFromAxisAngle(j.splay, s));
  }
}
// two-bone IK guess for the elbow so the forearm hangs naturally while the wrist bends
const UPPER_ARM = 0.27, FOREARM = 0.295;
const ikF = new THREE.Vector3(), ikU = new THREE.Vector3(), ikR = new THREE.Vector3(), shoulder = new THREE.Vector3(),
  wrist = new THREE.Vector3(), elbow = new THREE.Vector3(), ikD = new THREE.Vector3(), ikV = new THREE.Vector3(), mInv = new THREE.Matrix4();
function aimForearm(glove) {
  const { forearm, handBone, side } = glove.userData;
  if (!forearm || !handBone) return;
  const s = side === 'left' ? -1 : 1;
  camera.getWorldPosition(headPos); camera.getWorldQuaternion(q);
  ikU.set(0, 1, 0).applyQuaternion(rig.quaternion);
  ikF.set(0, 0, -1).applyQuaternion(q).projectOnPlane(ikU).normalize();
  ikR.crossVectors(ikF, ikU);
  shoulder.copy(headPos).addScaledVector(ikR, 0.17 * s).addScaledVector(ikU, -0.21).addScaledVector(ikF, -0.04);
  glove.updateMatrixWorld(true);
  handBone.getWorldPosition(wrist);
  ikD.copy(wrist).sub(shoulder);
  const L = THREE.MathUtils.clamp(ikD.length(), 0.08, UPPER_ARM + FOREARM - 0.001);
  ikD.normalize();
  // tuned from headset telemetry: elbows hang mostly down, only slightly out, and a bit forward
  ikV.copy(ikR).multiplyScalar(0.25 * s).addScaledVector(ikU, -1).addScaledVector(ikF, 0.3);
  ikV.addScaledVector(ikD, -ikV.dot(ikD)).normalize();
  const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + L * L) / (2 * L);
  const hgt = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
  elbow.copy(shoulder).addScaledVector(ikD, a).addScaledVector(ikV, hgt);
  glove.userData.ik = { shoulder: shoulder.toArray(), elbow: elbow.toArray(), wrist: wrist.toArray() };
  // aim the forearm bone (child of the hand bone) from the wrist at the elbow, limited to a human wrist range
  const dir = elbow.sub(wrist).transformDirection(mInv.copy(handBone.matrixWorld).invert());
  // only lean partway toward the elbow guess and keep the wrist bend small: a mostly straight gauntlet reads
  // better than a confidently wrong one (the guess kept pulling it down)
  qa.setFromUnitVectors(forearm.restDir, dir).slerp(qb.identity(), 0.6);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(qa.w)));
  if (ang > 0.45) qa.slerp(qb.identity(), 1 - 0.45 / ang);
  forearm.bone.quaternion.copy(qa).multiply(forearm.rest);
}

const SCREEN_W = 0.094, SCREEN_H = 0.058; // matches the forearm display glass
const screenCanvas = document.createElement('canvas'); screenCanvas.width = 512; screenCanvas.height = 320; // drawn in 256x160 units at 2x
const sctx = screenCanvas.getContext('2d');
const screenTex = new THREE.CanvasTexture(screenCanvas);
screenTex.magFilter = screenTex.minFilter = THREE.LinearFilter; screenTex.generateMipmaps = false;
screenTex.colorSpace = THREE.SRGBColorSpace;
const wristScreen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
// hand fit, tuned on the SET page and kept on the headset
const handCal = Object.assign({ pitch: 0.6, roll: 0, reach: 0 }, (() => { try { return JSON.parse(localStorage.getItem('nomad.hand')) || {}; } catch { return {}; } })());
const saveCal = () => { try { localStorage.setItem('nomad.hand', JSON.stringify(handCal)); } catch {} };
const PAGES = ['SUIT', 'CARGO', 'NAV', 'SET'];
let page = 'SUIT';
const TAB_BUTTONS = PAGES.map((p, i) => ({ id: 'page:' + p, x: 8 + i * 61, y: 30, w: 57, h: 20 }));
const PAGE_BUTTONS = {
  SUIT: [{ id: 'jet-', x: 150, y: 56, w: 44, h: 22 }, { id: 'jet+', x: 202, y: 56, w: 44, h: 22 },
    { id: 'light', x: 8, y: 84, w: 118, h: 24 }, { id: 'stab', x: 132, y: 84, w: 118, h: 24 }, { id: 'swap', x: 8, y: 114, w: 150, h: 24 }, { id: 'recall', x: 164, y: 114, w: 86, h: 24 }],
  CARGO: [], NAV: [],
  SET: [{ id: 'pitch-', x: 150, y: 56, w: 44, h: 22 }, { id: 'pitch+', x: 202, y: 56, w: 44, h: 22 },
    { id: 'roll-', x: 150, y: 82, w: 44, h: 22 }, { id: 'roll+', x: 202, y: 82, w: 44, h: 22 },
    { id: 'reach-', x: 150, y: 108, w: 44, h: 22 }, { id: 'reach+', x: 202, y: 108, w: 44, h: 22 }, { id: 'reset', x: 8, y: 134, w: 110, h: 18 }],
};
const screenButtons = () => [...TAB_BUTTONS, ...PAGE_BUTTONS[page]];
let pressedId = null;
const C = { ink: '#2bd9c4', dim: '#3d8a80', text: '#bff5ee', warn: '#ffd166', bg: '#071012', key: '#0d1c1e', on: '#12403b', hot: '#ff8a3d' };
function btn(g, b, label, on) {
  g.fillStyle = pressedId === b.id ? C.ink : on ? C.on : C.key; g.fillRect(b.x, b.y, b.w, b.h);
  g.strokeStyle = C.ink; g.lineWidth = 1; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  g.fillStyle = pressedId === b.id ? C.bg : C.text; g.textAlign = 'center'; g.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 1); g.textAlign = 'left';
}
const _sp = new THREE.Vector3();
function drawScreen(speed, tether) {
  const g = sctx; g.setTransform(2, 0, 0, 2, 0, 0);
  g.fillStyle = C.bg; g.fillRect(0, 0, 256, 160);
  g.strokeStyle = C.ink; g.lineWidth = 1.5; g.strokeRect(1.5, 1.5, 253, 157);
  g.font = 'bold 12px monospace'; g.textBaseline = 'middle';
  g.fillStyle = message && messageT > 0 ? C.warn : C.ink;
  g.fillText((message && messageT > 0 ? message : `${system.name.toUpperCase()}  //  ${place === 'inside' ? 'ABOARD' : 'EVA'}`).slice(0, 34), 8, 15);
  g.font = 'bold 10px monospace';
  for (const b of TAB_BUTTONS) btn(g, b, b.id.slice(5), page === b.id.slice(5));
  g.font = 'bold 11px monospace';
  const row = (y, k, v, col = C.text) => { g.fillStyle = C.dim; g.fillText(k, 10, y); g.fillStyle = col; g.fillText(v, 92, y); };
  if (page === 'SUIT') {
    g.fillStyle = C.ink; g.fillText('JET', 10, 67);
    for (let i = 0; i < JET_LEVELS.length; i++) { g.fillStyle = i <= suit.jetPower ? C.hot : '#16302e'; g.fillRect(40 + i * 20, 58, 16, 18); }
    for (const b of PAGE_BUTTONS.SUIT) btn(g, b, { 'jet-': '-', 'jet+': '+', light: `LIGHT ${suit.headlight ? 'ON' : 'OFF'}`, stab: `STAB ${suit.stabilizer ? 'ON' : 'OFF'}`,
      swap: `${suit.screenArm.toUpperCase()} ARM >> SWAP`, recall: rescue.on ? 'INBOUND' : rescue.armedT > 0 ? 'CONFIRM?' : 'RECALL' }[b.id],
      b.id === 'light' ? suit.headlight : b.id === 'stab' ? suit.stabilizer : b.id === 'recall' && (rescue.on || rescue.armedT > 0));
    g.fillStyle = tether > 38 ? '#ff5a4a' : '#7fb8b0'; g.font = '10px monospace';
    g.fillStyle = power.suit < 20 ? C.warn : tether > 38 ? '#ff5a4a' : '#7fb8b0';
    g.fillText(`PWR ${Math.round(power.suit)}%  ` + (landedOutside() ? `TOOL ${Math.round(mining.cells.miner)}%` : `SPD ${speed.toFixed(1)}m/s  TETHER ${tether.toFixed(0)}m`), 10, 150);
  } else if (page === 'CARGO') {
    const inv = mining.inv, items = Object.entries(inv.items);
    row(62, 'SUIT', `${inv.total().toFixed(1)} / ${inv.capacity} KG`, inv.free() <= 0 ? C.warn : C.text);
    g.fillStyle = '#16302e'; g.fillRect(10, 70, 236, 6); g.fillStyle = C.hot; g.fillRect(10, 70, 236 * inv.total() / inv.capacity, 6);
    if (!items.length) { g.fillStyle = C.dim; g.fillText('EMPTY  //  MINE A DEPOSIT', 10, 92); }
    items.slice(0, 4).forEach(([t, kg], i) => row(90 + i * 13, t.toUpperCase(), `${kg.toFixed(1)} KG`));
    row(146, 'CELLS', `M ${Math.round(mining.cells.miner)}% S ${Math.round(mining.cells.scanner)}%  HOLD ${mining.store.total().toFixed(0)}`);
  } else if (page === 'NAV') {
    const a = startBody.atmosphere;
    row(62, 'GRAVITY', `${(startBody.gravity / 9.81).toFixed(2)} G`);
    row(76, 'TEMP', `${startBody.temperature.surface} K  (${startBody.temperature.surface - 273} C)`);
    row(90, 'AIR', a.pressure < 0.001 ? 'VACUUM' : `${a.pressure < 0.1 ? a.pressure.toFixed(3) : a.pressure.toFixed(2)} BAR ${a.composition}`);
    if (place === 'outside') { // the ship from where you stand, as a bearing relative to where you're looking
      camera.getWorldPosition(_sp); const dx = -_sp.x, dz = -_sp.z, dist = Math.hypot(dx, dz);
      camera.getWorldDirection(tmp2); const rel = Math.atan2(dx, -dz) - Math.atan2(tmp2.x, -tmp2.z);
      row(106, 'SHIP', `${dist.toFixed(0)} M`);
      const cx = 200, cy = 128; g.strokeStyle = C.dim; g.beginPath(); g.arc(cx, cy, 20, 0, Math.PI * 2); g.stroke();
      g.save(); g.translate(cx, cy); g.rotate(rel); g.fillStyle = C.hot; g.beginPath(); g.moveTo(0, -17); g.lineTo(6, 4); g.lineTo(-6, 4); g.closePath(); g.fill(); g.restore();
      row(122, 'ALT', craft ? `${Math.max(0, craft.alt - craft.minAlt).toFixed(0)} M (SHIP)` : '-');
    } else row(106, 'SHIP', craft ? `${craft.mode}  ${Math.max(0, craft.alt - craft.minAlt).toFixed(0)} M` : 'ORBIT');
  } else if (page === 'SET') {
    g.font = 'bold 11px monospace';
    row(67, 'HAND PITCH', `${(handCal.pitch * 57.3).toFixed(0)}°`); row(93, 'HAND ROLL', `${(handCal.roll * 57.3).toFixed(0)}°`);
    row(119, 'HAND REACH', `${(handCal.reach * 100).toFixed(0)} CM`);
    for (const b of PAGE_BUTTONS.SET) btn(g, b, b.id === 'reset' ? 'RESET' : b.id.endsWith('-') ? '-' : '+');
  }
  g.fillStyle = '#3d6b66'; g.font = '9px monospace'; g.textAlign = 'right'; g.fillText(`${perf.stats.fps}fps ${BUILD}`, 248, page === 'SET' ? 143 : 150); g.textAlign = 'left';
  screenTex.needsUpdate = true;
}

// the poke point (index fingertip of the hand without the screen), drawn so you can see what touches the screen
const fingertip = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), new THREE.MeshBasicMaterial({ color: 0x2bd9c4 }));
const hands = {}; // by handedness
const pokeHand = () => hands[suit.screenArm === 'left' ? 'right' : 'left'];
function attachFingertip() { const g = pokeHand()?.glove; if (g) g.userData.tip?.add(fingertip); }
for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
  rig.add(ctrl, grip);
  const h = { ctrl, grip, source: null, grabbing: false, touching: false, anchor: new THREE.Vector3(), glove: null, loading: false, latch: {}, prevLocal: null };
  ctrl.addEventListener('connected', async e => {
    h.source = e.data; const side = e.data.handedness;
    for (const k of Object.keys(hands)) if (hands[k] === h) delete hands[k]; // controllers can come back swapped
    hands[side] = h;
    logEvent('connected', { side, handTracking: !!e.data.hand, gloveSide: h.glove?.userData.side ?? null });
    if (h.loading || h.glove?.userData.side === side) return;
    h.loading = true;
    const g = await makeGlove(side);
    if (h.glove) scene.remove(h.glove);
    h.glove = g; scene.add(g); h.loading = false;
    attachFingertip();
  });
  ctrl.addEventListener('disconnected', () => { h.source = null; });
}
patched.add(wristScreen.material); // keep the arm UI crisp and readable
scene.add(wristScreen);
const sx = new THREE.Vector3(), sy = new THREE.Vector3(), sz = new THREE.Vector3(), basis = new THREE.Matrix4();
function placeScreen() { // follow the forearm display; rebuild a proper frame so the mirrored left arm doesn't mirror the text
  for (const h of Object.values(hands)) if (h.glove?.userData.display) h.glove.userData.display.visible = h.glove.userData.side === suit.screenArm;
  const g = hands[suit.screenArm]?.glove, a = g?.userData.screen;
  wristScreen.visible = !!a && !!hands[suit.screenArm].source;
  if (!a) return;
  a.updateWorldMatrix(true, false);
  // the Blender empty's Z (screen normal) comes out of the glTF exporter as local +Y
  sx.set(g.userData.side === 'right' ? -1 : 1, 0, 0).transformDirection(a.matrixWorld); sz.set(0, 1, 0).transformDirection(a.matrixWorld); // only the left model is mirrored
  sy.crossVectors(sz, sx).normalize(); sx.crossVectors(sy, sz).normalize();
  wristScreen.quaternion.setFromRotationMatrix(basis.makeBasis(sx, sy, sz));
  a.getWorldPosition(wristScreen.position).addScaledVector(sz, 0.0005);
  wristScreen.updateMatrixWorld();
}
// Quest's pointing ray tilts ~35° down from how the hand sits on the controller (measured from headset telemetry)
const _hcal = new THREE.Quaternion(), _hcalE = new THREE.Euler(), _hreach = new THREE.Vector3();
function placeGloves() { // gloves sit on the palm (grip) and turn with the pointing ray; the forearm follows the elbow guess
  rig.updateMatrixWorld(true);
  for (const h of Object.values(hands)) {
    if (!h.glove) continue;
    h.glove.visible = !!h.source;
    h.grip.getWorldPosition(h.glove.position);
    const m = h.glove.userData.side === 'left' ? -1 : 1; // roll mirrors between hands
    h.ctrl.getWorldQuaternion(h.glove.quaternion).multiply(_hcal.setFromEuler(_hcalE.set(handCal.pitch, 0, handCal.roll * m)));
    if (handCal.reach) h.glove.position.add(_hreach.set(0, 0, -handCal.reach).applyQuaternion(h.glove.quaternion));
    aimForearm(h.glove);
  }
}

// exhaust particles, in world space so they trail behind you
const EXHAUST = 90;
const exGeo = new THREE.BufferGeometry();
exGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EXHAUST * 3).fill(-9999), 3));
const exVel = Array.from({ length: EXHAUST }, () => new THREE.Vector3()), exLife = new Float32Array(EXHAUST);
const exhaust = new THREE.Points(exGeo, new THREE.PointsMaterial({ color: 0x8fd0ff, size: 3, sizeAttenuation: false,
  transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
exhaust.frustumCulled = false;
scene.add(exhaust);
let exNext = 0;
const exDir = new THREE.Vector3(), exPos = new THREE.Vector3();
function updateJet(h, trig, dt) { // flame, hot nozzle and particles; returns the exhaust direction (thrust is the opposite)
  const u = h.glove?.userData; if (!u?.jet) return null;
  u.heatLevel += ((trig > 0.05 ? trig : 0) - u.heatLevel) * Math.min(1, dt * (trig > 0.05 ? 10 : 1.5));
  if (u.heat) u.heat.emissiveIntensity = u.heatLevel * 3.5;
  u.flame.visible = trig > 0.05;
  if (!u.flame.visible) return null;
  const f = 0.55 + trig * 0.6;
  u.flame.children[0].scale.set(f, f * (0.8 + Math.random() * 0.35), f);
  u.flame.children[1].scale.set(1, 0.7 + trig * 0.5 + Math.random() * 0.25, 1);
  exDir.set(0, 1, 0).transformDirection(u.jet.matrixWorld);
  u.jet.getWorldPosition(exPos);
  const pos = exGeo.attributes.position;
  for (let n = 0; n < Math.ceil(trig * 3); n++) {
    const i = exNext; exNext = (exNext + 1) % EXHAUST;
    exLife[i] = 0.18 + Math.random() * 0.22;
    pos.setXYZ(i, exPos.x, exPos.y, exPos.z);
    exVel[i].copy(exDir).multiplyScalar(2.2 + Math.random() * 1.5).add(vel)
      .add(tmp2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.35));
  }
  return exDir;
}
function updateExhaust(dt) {
  const pos = exGeo.attributes.position;
  for (let i = 0; i < EXHAUST; i++) {
    if (exLife[i] <= 0) continue;
    exLife[i] -= dt;
    if (exLife[i] <= 0) { pos.setXYZ(i, 0, -9999, 0); continue; }
    pos.setXYZ(i, pos.getX(i) + exVel[i].x * dt, pos.getY(i) + exVel[i].y * dt, pos.getZ(i) + exVel[i].z * dt);
  }
  pos.needsUpdate = true;
}
// ---------- audio (starts on Enter VR, which is a user gesture) ----------
let audio = null;
function startAudio() {
  if (audio) { if (audio.ac.state !== 'running') audio.ac.resume(); return; }
  const ac = new AudioContext();
  const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
  const gain = ac.createGain(); gain.gain.value = 0;
  src.connect(lp).connect(gain).connect(ac.destination); src.start();
  const hum = ac.createOscillator(); hum.frequency.value = 52;
  const humGain = ac.createGain(); humGain.gain.value = 0.03; hum.connect(humGain).connect(ac.destination); hum.start();
  audio = { ac, gain };
}
// The browser only lets audio start inside a real user gesture: the Enter VR tap, or a trigger/grip press in VR.
// sessionstart alone fires too late and leaves the context suspended (silent).
addEventListener('pointerdown', startAudio, true);
for (let i = 0; i < 2; i++) {
  renderer.xr.getController(i).addEventListener('selectstart', startAudio);
  renderer.xr.getController(i).addEventListener('squeezestart', startAudio);
}
function beep(f = 880) {
  if (!audio) return;
  const o = audio.ac.createOscillator(), g = audio.ac.createGain();
  o.type = 'square'; o.frequency.value = f; g.gain.value = 0.05;
  o.connect(g).connect(audio.ac.destination); o.start(); o.stop(audio.ac.currentTime + 0.06);
}
function buzz(h, s = 0.4, ms = 30) { h?.source?.gamepad?.hapticActuators?.[0]?.pulse?.(s, ms); }
function say(text) { message = text; messageT = 2.5; gameLog.push([simTime, text]); if (gameLog.length > 60) gameLog.shift(); }

function spawnOutside() {
  rig.rotation.set(0, -Math.PI / 2, 0);
  rig.updateMatrixWorld(true);
  camera.getWorldPosition(headPos);
  rig.position.add(tmp.copy(hatch).add(new THREE.Vector3(-0.9, 0, 0)).sub(headPos)); // just outside the hatch, within reach
  if (landedOutside()) { // down the ramp, on the ground
    rig.position.x -= 1.2; standCamY = camera.position.y; rig.updateMatrixWorld(true); camera.getWorldPosition(headPos);
    rig.position.y = groundUnder(headPos) + EYE_HEIGHT - standCamY;
  }
  vel.set(0, 0, 0); resetRope();
}
let insideRigY = 0, sitting = false, standCamY = 0;
function spawnChamber() { // just inside the outer door, facing in
  rig.rotation.set(0, -Math.PI / 2, 0); rig.updateMatrixWorld(true); camera.getWorldPosition(headPos);
  rig.position.add(tmp.set((interiorDoor?.x ?? -3.88) + 0.7, DECK_Y + EYE_HEIGHT, interiorDoor?.z ?? 2.75).sub(headPos));
  insideRigY = rig.position.y; vel.set(0, 0, 0); sitting = false;
}
const _seatEye = new THREE.Vector3();
function sitDown() { // turn to face the nose, then put your head where a seated pilot's is
  camera.getWorldDirection(tmp2); rig.rotation.y -= Math.atan2(-tmp2.x, -tmp2.z); rig.updateMatrixWorld(true);
  camera.getWorldPosition(headPos);
  rig.position.add(_seatEye.copy(pilotPos).add(new THREE.Vector3(0, 0.73, 0.08)).sub(headPos));
  insideRigY = rig.position.y; sitting = true; say('SEATED  //  B TO STAND'); beep(520);
}
function standUp() { // into the aisle behind the seat, standing height
  camera.getWorldPosition(headPos);
  rig.position.add(tmp.set(0, DECK_Y + EYE_HEIGHT, pilotPos.z + 0.85).sub(headPos));
  insideRigY = rig.position.y; sitting = false; say('STANDING'); beep(420);
}
function spawnInside() {
  rig.rotation.set(0, 0, 0);                         // facing forward, toward the lab and the bridge
  rig.updateMatrixWorld(true);
  camera.getWorldPosition(headPos);
  rig.position.add(tmp.copy(interiorSpawn).add(new THREE.Vector3(0, EYE_HEIGHT, 0)).sub(headPos));
  insideRigY = rig.position.y; vel.set(0, 0, 0); sitting = false;
}
renderer.xr.addEventListener('sessionstart', async () => {
  startAudio();
  renderer.xr.getSession()?.updateTargetFrameRate?.(TARGET_HZ).catch(() => {});
  camera.rotation.set(0, 0, 0);
  await firstLoad;
  if (place === 'inside') spawnInside(); else if (place === 'outside') spawnOutside();
  if (saved?.warpArrival) startArrival(); else say(`${system.name}  //  ${star.name}-TYPE STAR`);
});
// the Quest browser can keep you in VR across a same-site page load (the warp reloads into the new system)
navigator.xr?.addEventListener?.('sessiongranted', () => {
  navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'layers'] }).then(s => renderer.xr.setSession(s)).catch(() => {});
});

// fade to black for the airlock cycle (a sphere around your head, drawn last)
const fader = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }));
fader.renderOrder = 999; fader.visible = false;
camera.add(fader);
let fade = null;
const fadeTo = (to, secs) => new Promise(res => { fade = { from: fader.material.opacity, to, t: 0, secs, res }; });
function updateFade(dt) {
  if (!fade) return;
  fade.t += dt;
  const k = Math.min(1, fade.t / fade.secs);
  fader.material.opacity = fade.from + (fade.to - fade.from) * k;
  fader.visible = fader.material.opacity > 0.001;
  if (k >= 1) { const r = fade.res; fade = null; r(); }
}
function hiss(secs = 1.4, from = 2400, to = from) { // filtered noise; from/to sweep the pitch (air thinning or rushing back)
  if (!audio) return;
  const ac = audio.ac, n = ac.sampleRate * secs, buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.min(1, i / 2000) * (1 - i / n);
  const src = ac.createBufferSource(); src.buffer = buf;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(from, ac.currentTime); bp.frequency.exponentialRampToValueAtTime(to, ac.currentTime + secs); bp.Q.value = 0.6;
  const g = ac.createGain(); g.gain.value = 0.25;
  src.connect(bp).connect(g).connect(ac.destination); src.start();
}
// ---------- airlock: a real pressure cycle ----------
// Keypad CYCLE (or squeeze at the outer door) in the chamber: the inner door seals, the air pumps out over 4 s, then the
// outer door opens and stepping through it puts you outside. Coming in, the chamber repressurizes before the inner door opens.
let outerDoor = null, airlockLight = null;
const PUMP_S = 4;
function airlockCycle() {
  const a = G.airlock;
  if (place !== 'inside' || cycling) return;
  if (a.state === 'idle') { a.state = 'depress'; a.t = 0; hiss(PUMP_S, 3200, 250); say('AIRLOCK  //  DEPRESSURIZING'); }
  else if (a.state === 'open') { a.state = 'repress'; a.t = 0; hiss(PUMP_S, 300, 2600); say('AIRLOCK  //  REPRESSURIZING'); }
}
function updateAirlock(dt) {
  const a = G.airlock;
  if (place !== 'inside' || !outerDoor) return;
  a.t += dt;
  if (a.state === 'depress') {
    a.kPa = 101.3 * Math.max(0, 1 - a.t / PUMP_S);
    if (Math.floor(a.t) !== Math.floor(a.t - dt)) beep(500 - Math.floor(a.t) * 60);
    if (a.t >= PUMP_S) { a.state = 'open'; a.t = 0; beep(900); say('VACUUM  //  OUTER DOOR OPEN'); hiss(0.8); }
  } else if (a.state === 'repress') {
    a.kPa = 101.3 * Math.min(1, a.t / PUMP_S);
    if (a.t >= PUMP_S) { a.state = 'idle'; beep(660); say('PRESSURE OK  //  WELCOME ABOARD'); }
  }
  const before = outerDoor.open;
  outerDoor.open = THREE.MathUtils.clamp(outerDoor.open + (a.state === 'open' ? dt : -dt) / 1.2, 0, 1);
  if (before === 0 && outerDoor.open > 0) hiss(1.2, 1800, 600);
  outerDoor.o.position.y = outerDoor.y + THREE.MathUtils.smoothstep(outerDoor.open, 0, 1) * 2.3;
  for (const c of outerDoor.colliders) c.off = outerDoor.open > 0.5;
  if (airlockLight) { // red and pulsing while the pumps run or the door is open, green at pressure
    const busy = a.state !== 'idle';
    airlockLight.color.setHex(busy ? 0xff3020 : 0x5ee08a); airlockLight.intensity = busy ? 1.5 + 1.5 * Math.abs(Math.sin(G.t * 4)) : 2.5;
  }
  camera.getWorldPosition(headPos); // step through the open outer door
  if (a.state === 'open' && outerDoor.open > 0.85 && interiorDoor && headPos.x < interiorDoor.x + 0.15 && !cycling) cycleAirlock();
}
let cycling = false;
async function cycleAirlock() {
  if (cycling || warp.on) return;
  cycling = true;
  logEvent('cycle-start', { place });
  if (place === 'outside') { hiss(); say('AIRLOCK CYCLING...'); }
  for (const h of Object.values(hands)) h.grabbing = false;
  try {
    await fadeTo(1, 0.6);
    if (rescue.on) rebaseShip();
    if (place === 'outside') { // into the chamber, which then fills back up
      await loadInterior(); place = 'inside'; spawnChamber();
      Object.assign(G.airlock, { state: 'repress', kPa: 0, t: 0 }); hiss(PUMP_S, 300, 2600); say('AIRLOCK  //  REPRESSURIZING');
    }
    else { await loadExterior(); place = 'outside'; spawnOutside(); say('EVA  //  TETHER CLIPPED'); }
    if (rescue.on) endRescue();
    logEvent('cycle-done', { place }); saveGame(false);
  } catch (err) {
    logEvent('cycle-error', { msg: String(err?.stack || err) }); say('AIRLOCK FAULT');
  }
  await fadeTo(0, 0.7);
  cycling = false;
}
function logEvent(type, data) { fetch('/log', { method: 'POST', body: JSON.stringify({ t: +clock.elapsedTime.toFixed(2), ev: type, ...data }) }).catch(() => {}); }
addEventListener('error', e => logEvent('js-error', { msg: e.message, at: `${e.lineno}:${e.colno}` }));
addEventListener('unhandledrejection', e => logEvent('js-error', { msg: String(e.reason?.stack || e.reason) }));

// ---------- per-frame ----------
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), headPos = new THREE.Vector3(), q = new THREE.Quaternion();
const clock = new THREE.Clock();
let screenTimer = 0, t = 0;

// nearest ship surface to p, if it's within `radius`; fills out.point / out.normal (pointing away from the hull)
const _cp = new THREE.Vector3(), _best = new THREE.Vector3();
let lastHit = '';
function shipContact(p, radius, out) {
  let best = radius * radius;
  let hit = false;
  for (const c of shipColliders) {
    if (c.off || c.box.distanceToPoint(p) > radius) continue;
    for (const tri of c.tris) {
      tri.closestPointToPoint(p, _cp);
      const d = _cp.distanceToSquared(p);
      if (d < best) { best = d; _best.copy(_cp); hit = true; lastHit = c.name; if (out) tri.getNormal(out.normal); }
    }
  }
  if (!hit) return Infinity;
  const d = Math.sqrt(best);
  if (out) { out.point.copy(_best); if (d > 1e-4) out.normal.copy(p).sub(_best).divideScalar(d); }
  return d;
}
function toggle(id) {
  if (id.startsWith('page:')) { page = id.slice(5); beep(760); pressedId = id; return; }
  if (/^(pitch|roll|reach)[-+]$|^reset$/.test(id)) {
    const k = id.slice(0, -1), d = id.endsWith('+') ? 1 : -1;
    if (id === 'reset') Object.assign(handCal, { pitch: 0.6, roll: 0, reach: 0 }); else handCal[k] += d * (k === 'reach' ? 0.01 : 0.035); // 2 degrees, 1 cm
    saveCal(); beep(id === 'reset' ? 400 : 700 + d * 120); return;
  }
  if (id === 'recall') { // two taps, so a stray poke doesn't call the ship
    if (place !== 'outside') say('ABOARD  //  NO RECALL NEEDED'); else if (rescue.armedT > 0) startRescue('REQUESTED'); else { rescue.armedT = 3; say('TAP RECALL AGAIN TO CONFIRM'); }
    pressedId = id; beep(500); return;
  }
  if (id === 'jet-') suit.jetPower = Math.max(0, suit.jetPower - 1);
  if (id === 'jet+') suit.jetPower = Math.min(JET_LEVELS.length - 1, suit.jetPower + 1);
  if (id === 'light') suit.headlight = !suit.headlight;
  if (id === 'stab') suit.stabilizer = !suit.stabilizer;
  if (id === 'swap') { suit.screenArm = suit.screenArm === 'left' ? 'right' : 'left'; attachFingertip(); pressedId = 'swap'; }
  beep(id === 'jet-' ? 520 : 880);
}

function walk(x, y, dt) { // artificial gravity inside: left stick walks you along the deck, relative to where you look
  if (Math.hypot(x, y) < 0.15) return;
  camera.getWorldQuaternion(q);
  tmp2.set(0, 0, -1).applyQuaternion(q); tmp2.y = 0; tmp2.normalize();
  const fx = tmp2.x, fz = tmp2.z;
  rig.position.x += (fx * -y + -fz * x) * 1.8 * dt;
  rig.position.z += (fz * -y + fx * x) * 1.8 * dt;
}
let jetUse = 0; const _pw = new THREE.Vector3();
function updatePower(dt) {
  const p = power, was = p.suit, wasCharging = p.charging;
  if (place === 'outside') { // ~20 minutes of plain EVA; jets, the lamp and hot or cold ground cost more
    const hazard = Math.min(1, Math.abs(startBody.temperature.surface - 288) / 300) * 0.15;
    p.suit = Math.max(0, p.suit - (0.08 + hazard + 0.5 * jetUse + (suit.headlight ? 0.02 : 0)) * dt);
  }
  p.charging = place === 'inside' && !!chargerAt && Object.values(hands).some(h => h.glove && h.glove.getWorldPosition(_pw).distanceTo(chargerAt) < 0.2);
  if (p.charging) p.suit = Math.min(100, p.suit + 6 * dt); // arm in the cuff: about 15 s from empty
  if (p.charging && !wasCharging) { say(p.suit < 100 ? 'SUIT CHARGING' : 'SUIT CHARGED'); beep(700); }
  if (p.charging && was < 100 && p.suit === 100) { say('SUIT CHARGED'); beep(1300); }
  if (was > 20 && p.suit <= 20) { say('SUIT POWER 20%  //  HEAD BACK'); beep(300); }
  if (was > 0 && p.suit === 0) { say('SUIT POWER OUT  //  LIFE SUPPORT ON RESERVE'); beep(220); }
  p.outT = place === 'outside' && p.suit <= 0 ? (p.outT || 0) + dt : 0;
  if (p.outT > 15) startRescue('SUIT POWER OUT');
  headlight.visible = suit.headlight && p.suit > 0;
  if (craft) p.fuel = Math.min(100, p.fuel + 0.04 * dt); // the reactor refills the tank in about 40 minutes
}
// ---------- emergency recall (HANDOFF 3.4): the ship comes for you, never a teleport. In space the tether winch reels you
// in; on the ground the ship lifts off, flies over, lands beside you and a tractor beam draws you to the hatch.
// The cost: half your suit cargo. Specimens, tools and research are kept. ----------
const rescue = { on: false, phase: '', t: 0, dur: 0, to: new THREE.Vector3(), armedT: 0 };
const tractor = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.35, 1, 12, 1, true).translate(0, 0.5, 0),
  new THREE.MeshBasicMaterial({ color: 0x5ee0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
tractor.visible = false; tractor.frustumCulled = false; scene.add(tractor);
const _rz = new THREE.Vector3(), _hw = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
function startRescue(why) {
  if (rescue.on || place !== 'outside' || cycling) return;
  Object.assign(rescue, { on: true, t: 0, armedT: 0 }); say(`EMERGENCY RECALL  //  ${why}`); beep(330);
  if (!landedOutside()) { rescue.phase = 'reel'; return; } // EVA: you're on the tether
  camera.getWorldPosition(headPos);
  rescue.to.set(headPos.x - (hatch.x - 1.4), 0, headPos.z - hatch.z); // the hatch ends up 1.4 m from you
  if (Math.hypot(rescue.to.x, rescue.to.z) < 3) { rescue.phase = 'pull'; rescue.to.set(0, 0, 0); return; } // already close: just the beam
  rescue.to.y = groundUnder(_rz.copy(rescue.to)) - groundUnder(_rz.set(0, 0, 0)); // the ground there is higher or lower
  rescue.phase = 'fly'; rescue.dur = 6 + Math.hypot(rescue.to.x, rescue.to.z) / 20;
  say('SHIP INBOUND  //  STAND CLEAR');
}
function updateRescue(dt) {
  rescue.armedT = Math.max(0, rescue.armedT - dt);
  if (!rescue.on) return;
  rescue.t += dt;
  if (rescue.phase === 'reel') { // let the winch wind you in, then cycle
    reeling = true;
    if (rig.position.distanceTo(tetherClip) < 2.5 || rescue.t > 40) { rescue.phase = 'board'; cycleAirlock(); } // the reel stops ~1.3 m from the clip
  } else if (rescue.phase === 'fly') { // up, across, down
    const k = Math.min(1, rescue.t / rescue.dur), hor = THREE.MathUtils.smoothstep(k, 0.15, 0.85);
    ship.position.set(rescue.to.x * hor, rescue.to.y * hor + 22 * Math.sin(Math.PI * k), rescue.to.z * hor);
    if (k >= 1) { ship.position.copy(rescue.to); rescue.phase = 'pull'; rescue.t = 0; say('TRACTOR LOCK'); beep(880); }
  } else if (rescue.phase === 'pull') { // drawn along the ground to below the hatch
    _hw.copy(hatch).add(ship.position); camera.getWorldPosition(headPos);
    const dx = _hw.x - 0.9 - headPos.x, dz = _hw.z - headPos.z, d = Math.hypot(dx, dz), step = Math.min(d, 1.4 * dt);
    if (d > 1e-3) { rig.position.x += dx / d * step; rig.position.z += dz / d * step; }
    tractor.visible = true; tractor.position.copy(_hw);
    _rz.copy(headPos).sub(_hw); tractor.scale.set(1, _rz.length(), 1); tractor.quaternion.setFromUnitVectors(_Y, _rz.normalize());
    tractor.material.opacity = 0.18 + 0.08 * Math.sin(rescue.t * 12);
    if (d < 0.3 || rescue.t > 8) { rescue.phase = 'board'; tractor.visible = false; cycleAirlock(); }
  }
}
function rebaseShip() { // the ship really moved: slide the craft over the planet by where the model went, model back to the origin
  const T = ship.position, hor = Math.hypot(T.x, T.z);
  if (craft && hor > 1e-3) {
    _mv.copy(craft.right).multiplyScalar(T.x).addScaledVector(craft.fwd, -T.z).normalize();
    _ax.crossVectors(craft.dir, _mv).normalize();
    const ang = hor / (startBody.radius + surface.ground(craft.dir) + craft.alt);
    craft.dir.applyAxisAngle(_ax, ang).normalize(); craft.fwd.applyAxisAngle(_ax, ang);
  }
  ship.position.set(0, 0, 0);
}
function endRescue() {
  let lost = 0;
  for (const [t, kg] of Object.entries(mining.inv.items)) { lost += kg / 2; mining.inv.items[t] = kg / 2; }
  rescue.on = false; tractor.visible = false; power.outT = 0;
  say(lost > 0.05 ? `RESCUED  //  ${lost.toFixed(1)} KG OF SUIT CARGO LOST` : 'RESCUED  //  WELCOME BACK');
}
// ---------- warp (HANDOFF 3.3): lock a star on the computer's radar, engage from orbit, a visible journey whose length
// grows with distance. Star streaks rush past the nose; then a white-out, a save that describes the arrival, and a page
// load into the new system (the Quest keeps you in VR through it via sessiongranted). Comfort: the ship never turns. ----------
const warp = { on: false, t: 0, dur: 0, target: null, committed: false }, arrival = { on: false, t: 0, dur: 2.5 };
const STREAKS = 500, streakPos = new Float32Array(STREAKS * 6), streakZ = new Float32Array(STREAKS);
const streaks = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(streakPos, 3)),
  new THREE.LineBasicMaterial({ color: 0xbfe2ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
streaks.frustumCulled = false; streaks.visible = false; scene.add(streaks);
for (let i = 0; i < STREAKS; i++) { // a hollow tube of points 25-400 m out, so none cross the cabin
  const a = Math.random() * Math.PI * 2, r = 25 + Math.random() ** 0.7 * 375;
  streakPos[i * 6] = streakPos[i * 6 + 3] = Math.cos(a) * r; streakPos[i * 6 + 1] = streakPos[i * 6 + 4] = Math.sin(a) * r; streakZ[i] = -3000 + Math.random() * 3200;
}
function engageWarp() {
  const t = nav.lock, parts = UPGRADES.filter(u => u.warp && G.built[u.id]).length;
  const fail = warp.on ? 'WARP IN PROGRESS' : parts < 4 ? 'WARP DRIVE OFFLINE' : !t ? 'NO TARGET LOCKED' : place !== 'inside' ? 'BOARD THE SHIP FIRST'
    : craft && craft.mode !== 'ORBIT' ? 'CLIMB TO ORBIT FIRST' : power.warp < warpCost(t.dist) ? `WARP FUEL ${Math.round(power.warp)}%  //  NEED ${warpCost(t.dist)}%` : null;
  if (fail) { say(fail); beep(300); return; }
  power.warp -= warpCost(t.dist);
  Object.assign(warp, { on: true, t: 0, dur: 4 + 0.6 * t.dist, target: t, committed: false }); // ~7 s for 5 ly, ~40 s for 60 ly
  say(`WARP  //  ${t.name}  ${t.dist.toFixed(1)} LY`); hiss(2.5, 300, 3200); beep(200);
}
function startArrival() { // out of the white, the streaks slow to a stop (again when the headset session starts, so you see it)
  Object.assign(arrival, { on: true, t: 0 }); fader.material.color.set(0xffffff); fader.material.opacity = 1; fader.visible = true;
  fadeTo(0, 1.4).then(() => fader.material.color.set(0x000000));
  if (!arrival.said) { arrival.said = true; say(`ARRIVED  //  ${system.name}  //  ${saved.warpArrival.ly.toFixed(1)} LY FROM ${saved.warpArrival.from.toUpperCase()}`); }
}
if (saved?.warpArrival) firstLoad.then(() => { if (!renderer.xr.isPresenting) startArrival(); });
function updateWarp(dt) {
  let v = 0;
  if (warp.on) {
    warp.t += dt; const k = warp.t / warp.dur;
    v = THREE.MathUtils.smoothstep(k, 0, 0.3);
    const away = k > 0.12; // the system drops behind: no sky, no planets, no sun in the cabin
    skyFrame.visible = sunObj.visible = !away; sun.visible = !away; for (const bv of bodyViews) bv.g.visible = !away && !(surface && bv.b === startBody);
    if (surface) surface.group.visible = !away; // warp starts from orbit, so the air is already thin enough not to matter
    if (k >= 1 && !warp.committed) {
      warp.committed = true; if (!nav.visited.includes(String(warp.target.index))) nav.visited.push(String(warp.target.index));
      fader.material.color.set(0xffffff);
      fadeTo(1, 0.8).then(() => {
        saveGame(false);
        const keep = new URLSearchParams([...params].filter(([k]) => ['fb', 'hz', 'lodk'].includes(k)));
        location.href = location.pathname + (keep.toString() ? '?' + keep : '');
      });
    }
  } else if (arrival.on) {
    arrival.t += dt; v = 1 - THREE.MathUtils.smoothstep(arrival.t / arrival.dur, 0, 1);
    if (arrival.t >= arrival.dur) arrival.on = false;
  }
  streaks.visible = v > 0.01; if (!streaks.visible) return;
  const speed = 30 + v * 6000, len = 2 + v * 450;
  for (let i = 0; i < STREAKS; i++) {
    streakZ[i] += speed * dt; if (streakZ[i] > 200) streakZ[i] -= 3200;
    streakPos[i * 6 + 2] = streakZ[i]; streakPos[i * 6 + 5] = streakZ[i] - len;
  }
  streaks.geometry.attributes.position.needsUpdate = true; streaks.material.opacity = 0.3 + 0.6 * v;
}
// ---------- landing gear, boarding ladder, touchdown ----------
let legParts = [], legL = [LEG_STOW, LEG_STOW, LEG_STOW, LEG_STOW], gearDown = false;
const ladder = (() => { // two rails and rungs every 30 cm, built here so the rung spacing stays fixed as it extends
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8c90, metalness: 0.6, roughness: 0.45 }), group = new THREE.Group();
  retro(mat);
  const rails = [-0.22, 0.22].map(z => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1, 0.05).translate(0, -0.5, 0), mat); m.position.z = z; group.add(m); return m; });
  const rungs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 0.44, 6).rotateX(Math.PI / 2), mat, 24);
  rungs.count = 0; group.add(rungs); group.visible = false; group.rotation.z = -0.12; // leans out from the hull
  return { group, rails, rungs, mat, len: 0 };
})();
const _lm = new THREE.Matrix4();
function updateGear(dt) { // runs while the exterior is loaded: legs reach for the ground, the ladder drops when landed
  if (!craft || !legParts.length) return;
  const s = craft, h = s.alt - s.minAlt, low = s.mode !== 'ORBIT' && s.mode !== 'ASCENT' && h < 250;
  const want = s.mode === 'LANDED' || low;
  if (want !== gearDown) { gearDown = want; say(want ? 'GEAR DOWN' : 'GEAR UP'); hiss(1.0, 900, 400); }
  legParts.forEach((p, i) => {
    const reach = THREE.MathUtils.clamp(s.alt + POD_Y - FOOT_H - s.legG[i], LEG_STOW, LEG_MAX); // to the ground, or full stretch
    const target = gearDown ? reach : LEG_STOW;
    legL[i] = gearDown && reach < LEG_MAX - 0.01 ? target : legL[i] + THREE.MathUtils.clamp(target - legL[i], -1.8 * dt, 1.8 * dt); // in contact: track the ground
    p.lower.scale.y = legL[i]; p.upper.scale.y = 1.3 * THREE.MathUtils.clamp(legL[i] / 1.4, 0.25, 1);
    p.foot.position.y = p.y0 - legL[i];
    if (s.mode === 'LANDED' && s.groundAt) { // pads lie flat on the slope under them
      const [x, z] = LEGS[i], sx = (s.groundAt(x + 0.7, z) - s.groundAt(x - 0.7, z)) / 1.4, sz = (s.groundAt(x, z + 0.7) - s.groundAt(x, z - 0.7)) / 1.4;
      p.foot.rotation.set(-Math.atan(sz), 0, Math.atan(sx));
    } else p.foot.rotation.set(0, 0, 0);
  });
  // the ladder: from the hatch sill down to the ground beside it
  const top = hatch.y - 0.98, groundY = s.groundAt ? s.groundAt(hatch.x - 0.5, hatch.z) - s.alt : top - 3;
  const want2 = s.mode === 'LANDED' && !(rescue.on && rescue.phase === 'fly') ? Math.max(0, (top - groundY) / Math.cos(0.12)) : 0;
  ladder.len += THREE.MathUtils.clamp(want2 - ladder.len, -2.5 * dt, 1.5 * dt);
  ladder.group.visible = ladder.len > 0.05;
  if (ladder.group.visible) {
    ladder.group.position.set(hatch.x - 0.12, top, hatch.z);
    for (const r of ladder.rails) r.scale.y = ladder.len;
    const n = Math.min(24, Math.floor(ladder.len / 0.3));
    for (let k = 0; k < n; k++) ladder.rungs.setMatrixAt(k, _lm.makeTranslation(0, -0.15 - k * 0.3, 0));
    ladder.rungs.count = n; ladder.rungs.instanceMatrix.needsUpdate = true;
  }
}
// dust: a burst at each foot on touchdown and wash under the engines while hovering low (vacuum or not: it's thrust)
const DUST = 600, dustPos = new Float32Array(DUST * 3), dustVel = Array.from({ length: DUST }, () => new THREE.Vector3()), dustLife = new Float32Array(DUST), dustA = new Float32Array(DUST);
const dustGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dustPos, 3)).setAttribute('alpha', new THREE.BufferAttribute(dustA, 1));
const dustColor = ramp(KIND_RAMPS[startBody.kind] || KIND_RAMPS.dead, startBody.kind === 'ocean' ? 0.53 : 0.7);
const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color() } }, transparent: true, depthWrite: false,
  vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = 900.0 / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform vec3 color; varying float vA; void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(color, vA * (1.0 - d * 2.0) * 0.55);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' }));
dust.frustumCulled = false; scene.add(dust);
let dustNext = 0;
function puff(x, y, z, speed, n) {
  for (let k = 0; k < n; k++) {
    const i = dustNext; dustNext = (dustNext + 1) % DUST;
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    dustPos[i * 3] = x; dustPos[i * 3 + 1] = y + 0.1; dustPos[i * 3 + 2] = z;
    dustVel[i].set(Math.cos(a) * v, 0.4 + Math.random() * 1.2, Math.sin(a) * v); dustLife[i] = 2 + Math.random() * 2;
  }
}
function updateDust(dt) {
  const s = craft;
  if (s && s.groundAt && s.mode !== 'LANDED' && s.mode !== 'ORBIT') { // engine wash under 20 m
    const h = s.alt - s.minAlt;
    const rate = h < 20 ? (1 - h / 20) * 120 * dt : 0; // particles this frame, the fraction carried by chance
    for (let n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0); n > 0; n--) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6, x = Math.cos(a) * r, z = Math.sin(a) * r;
      puff(x, s.groundAt(x, z) - s.alt, z, 6, 1);
    }
  }
  let live = false;
  for (let i = 0; i < DUST; i++) {
    if (dustLife[i] <= 0) { dustA[i] = 0; continue; }
    live = true; dustLife[i] -= dt; dustVel[i].multiplyScalar(Math.exp(-1.1 * dt)); dustVel[i].y -= 0.6 * dt;
    dustPos[i * 3] += dustVel[i].x * dt; dustPos[i * 3 + 1] += dustVel[i].y * dt; dustPos[i * 3 + 2] += dustVel[i].z * dt;
    dustA[i] = Math.min(1, dustLife[i] / 1.5);
  }
  dust.visible = live;
  if (live) dust.material.uniforms.color.value.copy(dustColor).multiply(sun.color).multiplyScalar(0.25 + 0.3 * Math.min(3, sun.intensity)); // lit like the ground
  if (live) { dustGeo.attributes.position.needsUpdate = true; dustGeo.attributes.alpha.needsUpdate = true; }
}
function touchdown() { // dust from every foot, a low thump, both hands rumble; the view never shakes (comfort)
  const s = craft;
  LEGS.forEach(([x, z], i) => puff(x, s.legG[i] - s.alt, z, 4, 40));
  if (audio) {
    const ac = audio.ac, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(70, ac.currentTime); o.frequency.exponentialRampToValueAtTime(32, ac.currentTime + 0.5);
    g.gain.setValueAtTime(0.5, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.6);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.65);
  }
  hiss(1.6, 1400, 300);
  for (const h of Object.values(hands)) buzz(h, 1, 160);
}
function updateHands(dt) {
  let thrust = 0;
  const grabbed = [];
  for (const side of ['left', 'right']) {
    const h = hands[side]; if (!h?.source?.gamepad) continue;
    const gp = h.source.gamepad, b = gp.buttons;
    const squeeze = b[1]?.pressed, trig = b[0]?.value || 0;
    h.grip.getWorldPosition(tmp);
    // grab: squeeze with your palm on the hull and your hand sticks to it
    const door = place === 'outside' ? hatch : interiorDoor;
    if (squeeze && !h.latch.squeeze) {
      const surf = shipContact(tmp, 0.3);
      logEvent('squeeze', { side, place, toDoor: +tmp.distanceTo(door).toFixed(2), surf: isFinite(surf) ? +surf.toFixed(3) : null, hit: lastHit, cycling });
    }
    const atDoor = landedOutside() ? Math.hypot(tmp.x - door.x, tmp.z - door.z) < 2.5 : tmp.distanceTo(door) < 1.0; // landed, the hatch is ~3 m up
    if (h.ctl) { /* holding a cockpit control */ }
    else if (squeeze && !h.latch.squeeze && place === 'inside' && !sitting && pilotPos && tmp.distanceTo(_seatEye.copy(pilotPos).add(new THREE.Vector3(0, 0.3, 0.2))) < 0.5) sitDown();
    else if (squeeze && !h.latch.squeeze && !cycling && overShoulder(tmp)) mining.shoulder(h);
    else if (squeeze && !h.latch.squeeze && !cycling && mining.squeeze(h, tmp)) { /* tool or specimen */ }
    else if (squeeze && !h.latch.squeeze && !cycling && atDoor) { buzz(h, 0.8, 60); place === 'inside' ? airlockCycle() : cycleAirlock(); }
    else if (squeeze && !h.grabbing && !cycling && !mining.holding(h) && place === 'outside' && !landedOutside() && shipContact(tmp, 0.07) < 0.07) { h.grabbing = true; h.anchor.copy(tmp); buzz(h, 0.6, 40); }
    if (!squeeze && h.latch.squeeze) mining.release(h, { heightAboveGround: p => (craft ? heightAboveGround(p) : 1), dock: dockAt });
    h.latch.squeeze = squeeze;
    if (!squeeze && h.grabbing) h.grabbing = false;
    if (h.grabbing) grabbed.push(h);
    if (h.glove) poseFingers(h, gp);
    // hand jet: thrust is opposite the exhaust coming out of the nozzle
    const ex = updateJet(h, h.grabbing || place === 'inside' || landedOutside() || mining.holding(h) || power.suit <= 0 ? 0 : trig, dt); // the tool hand's trigger fires the tool
    if (ex) {
      vel.addScaledVector(ex, -JET_LEVELS[suit.jetPower] * trig * dt);
      thrust += trig;
      if (Math.random() < 0.3) buzz(h, 0.15 * trig, 20);
    }
    // buttons: edge-triggered
    const edge = (i, fn) => { const p = b[i]?.pressed; if (p && !h.latch[i]) fn(); h.latch[i] = p; };
    if (side === 'left') {
      edge(4, () => toggle('light')); edge(5, () => toggle('jet+'));
      if (((place === 'inside' && !seated) || landedOutside()) && !rescue.on) walk(gp.axes[2] || 0, gp.axes[3] || 0, dt);
    }
    if (side === 'right') {
      edge(4, () => toggle('stab'));
      if (sitting) edge(5, standUp); // B
      reeling = (!!b[5]?.pressed || (rescue.on && rescue.phase === 'reel')) && place === 'outside' && !landedOutside();
      if (reeling && Math.random() < 0.25) buzz(h, 0.2, 15);
      const sx = gp.axes[2] || 0; // snap turn around your head
      if (Math.abs(sx) > 0.7 && !h.latch.turn && !seated) {
        camera.getWorldPosition(headPos);
        rig.rotation.y -= Math.sign(sx) * Math.PI / 6;
        rig.updateMatrixWorld(true);
        camera.getWorldPosition(tmp2);
        rig.position.add(headPos).sub(tmp2);
        h.latch.turn = true;
      } else if (Math.abs(sx) < 0.3) h.latch.turn = false;
    }
  }
  // climbing locomotion: move the rig so grabbed hands stay pinned; release flings you
  if (grabbed.length) {
    const delta = new THREE.Vector3();
    for (const h of grabbed) { h.grip.getWorldPosition(tmp); delta.add(tmp.sub(h.anchor)); }
    delta.divideScalar(grabbed.length);
    rig.position.sub(delta);
    if (dt > 0) vel.copy(delta).multiplyScalar(-1 / dt).clampLength(0, 6);
  }
  if (audio) audio.gain.gain.value = Math.min(0.35, thrust * 0.2);
  jetUse = thrust;
  return grabbed.length > 0;
}

// solid hands + head: your palm and fingertip can't pass into the hull; pushing on it moves you instead
const contact = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
const armVel = new THREE.Vector3(), probe = new THREE.Vector3();
function resolveContact(p, r, push) { // push = how fast your arm drives into the surface counts toward your new velocity
  const d = shipContact(p, r, contact);
  if (d >= r) return false;
  rig.position.addScaledVector(contact.normal, r - d);
  p.addScaledVector(contact.normal, r - d);
  const vn = vel.dot(contact.normal);
  const shove = push ? -push.dot(contact.normal) * 0.9 : 0;          // > 0 when the hand moves into the hull
  if (vn < shove) vel.addScaledVector(contact.normal, shove - vn); // kills inward motion, adds the push-off
  return true;
}
function collide(dt) {
  rig.updateMatrixWorld(true);
  for (const side of ['left', 'right']) {
    const h = hands[side];
    if (!h?.source) continue;
    // arm speed relative to your body, in world space
    if (!h.prevLocal) h.prevLocal = h.grip.position.clone();
    armVel.copy(h.grip.position).sub(h.prevLocal).divideScalar(Math.max(dt, 1e-3)).applyQuaternion(rig.quaternion);
    h.prevLocal.copy(h.grip.position);
    if (h.grabbing || place === 'inside') { h.touching = false; continue; } // pushing off walls is for EVA only
    let touching = resolveContact(h.grip.getWorldPosition(probe), 0.045, armVel);
    const tip = h.glove?.userData.tip;
    if (tip) touching = resolveContact(tip.getWorldPosition(probe), 0.012, armVel) || touching;
    if (touching && !h.touching) buzz(h, 0.35, 25);
    h.touching = touching;
  }
  if (!sitting) resolveContact(camera.getWorldPosition(headPos), place === 'inside' ? 0.25 : 0.22, null);
  if (place === 'inside') { rig.position.y = insideRigY; vel.set(0, 0, 0); } // walls push you sideways, never off the deck
  else if (landedOutside()) { // 'local' space: the rig origin is where your head started, so hold the head at standing height
    camera.getWorldPosition(headPos);
    rig.position.y += (groundUnder(headPos) + EYE_HEIGHT - standCamY - rig.position.y) * Math.min(1, dt * 20);
  }
}

function updateInnerDoor(dt) {
  if (!innerDoor || place !== 'inside') return;
  camera.getWorldPosition(headPos);
  const near = Math.hypot(headPos.x - innerDoor.center.x, headPos.z - innerDoor.center.z) < 1.6 && G.airlock.state === 'idle';
  const before = innerDoor.open;
  innerDoor.open = THREE.MathUtils.clamp(innerDoor.open + (near ? dt : -dt) / 0.8, 0, 1);
  if (before !== innerDoor.open && (before === 0 || before === 1)) hiss();
  const lift = THREE.MathUtils.smoothstep(innerDoor.open, 0, 1) * 2.2;
  innerDoor.parts.forEach((p, i) => { p.position.y = innerDoor.base[i] + lift; });
  for (const c of innerDoor.colliders) c.off = innerDoor.open > 0.4;
}
function updatePoke() {
  const r = pokeHand();
  if (!r || !wristScreen.visible || !fingertip.parent) return;
  const local = wristScreen.worldToLocal(fingertip.getWorldPosition(tmp));
  const inside = Math.abs(local.x) < SCREEN_W / 2 && Math.abs(local.y) < SCREEN_H / 2;
  if (inside && Math.abs(local.z) < 0.015) {
    const px = (local.x / SCREEN_W + 0.5) * 256, py = (0.5 - local.y / SCREEN_H) * 160;
    const btn = screenButtons().find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    if (btn && !pressedId) { pressedId = btn.id; toggle(btn.id); buzz(r, 0.5, 25); }
  } else if (!inside || local.z > 0.03) pressedId = null;
}

// tether: a verlet rope from the clip by the hatch to your suit. No gravity, so slack just floats and drifts;
// a reel on the suit pays out / takes up line so it stays a little slack instead of piling up in coils.
const ROPE_N = 44, TETHER_MAX = 45;
const ropeP = Array.from({ length: ROPE_N }, () => new THREE.Vector3()), ropeOld = ropeP.map(v => v.clone());
let ropeLen = 3, ropeFrame = 0, reeling = false;
const ropeMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 6, 1, true),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), ROPE_N - 1);
ropeMesh.frustumCulled = false;
for (let i = 0; i < ROPE_N - 1; i++) ropeMesh.setColorAt(i, new THREE.Color(Math.floor(i / 2) % 2 ? 0xe8e4da : 0xe0601a)); // safety-orange bands
scene.add(ropeMesh);
const clipA = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.12), new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.8, roughness: 0.4 }));
const clipB = new THREE.Group(); // the suit's tether reel
const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0xe0601a, roughness: 0.6 }));
spool.rotation.z = Math.PI / 2; clipB.add(spool);
const spoolHub = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.02), clipA.material); spool.add(spoolHub);
scene.add(clipA, clipB);
const belt = new THREE.Vector3(), ropeUp = new THREE.Vector3(), ropeDir = new THREE.Vector3(), ropeM = new THREE.Matrix4(), ropeQ = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0), ropeScale = new THREE.Vector3();
function beltPoint(out) { // a spot on the suit's hip, below and slightly behind your head
  camera.getWorldPosition(out); camera.getWorldQuaternion(q);
  ropeUp.set(0, 1, 0).applyQuaternion(rig.quaternion);
  ropeDir.set(0, 0, -1).applyQuaternion(q).projectOnPlane(ropeUp).normalize();
  return out.addScaledVector(ropeUp, -0.6).addScaledVector(ropeDir, -0.08);
}
function resetRope() {
  beltPoint(belt);
  for (let i = 0; i < ROPE_N; i++) { ropeP[i].lerpVectors(tetherClip, belt, i / (ROPE_N - 1)); ropeOld[i].copy(ropeP[i]); }
  ropeLen = tetherClip.distanceTo(belt) * 1.15 + 0.8;
}
function updateRope(dt) {
  const show = renderer.xr.isPresenting && place === 'outside' && !landedOutside(); // no tether on the ground
  ropeMesh.visible = clipA.visible = clipB.visible = show;
  if (!show) return;
  beltPoint(belt);
  spool.rotation.x += (reeling ? 18 : 0) * dt;
  if (reeling) ropeLen = Math.max(1.0, Math.min(ropeLen, tetherClip.distanceTo(belt) + 0.3) - 2.2 * dt); // winds the line onto the reel
  else {
    const want = THREE.MathUtils.clamp(tetherClip.distanceTo(belt) * 1.12 + 1.0, 2, TETHER_MAX);
    ropeLen += THREE.MathUtils.clamp(want - ropeLen, -2.5 * dt, 4 * dt); // auto-reel keeps a little slack
  }
  const seg = ropeLen / (ROPE_N - 1);
  for (let i = 1; i < ROPE_N - 1; i++) { // verlet, zero gravity, light damping
    const p = ropeP[i], o = ropeOld[i];
    const vx = (p.x - o.x) * 0.985, vy = (p.y - o.y) * 0.985, vz = (p.z - o.z) * 0.985;
    o.copy(p); p.x += vx; p.y += vy; p.z += vz;
  }
  ropeP[0].copy(tetherClip); ropeP[ROPE_N - 1].copy(belt);
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < ROPE_N - 1; i++) { // rope can go slack but never stretch
      const a = ropeP[i], b = ropeP[i + 1];
      ropeDir.subVectors(b, a); const d = ropeDir.length();
      if ((d <= seg && !reeling) || d < 1e-6) continue; // slack is allowed, except while the reel is winding
      const k = (d - seg) / d;
      const wa = i === 0 ? 0 : i + 1 === ROPE_N - 1 ? 1 : 0.5, wb = i === 0 ? 1 : i + 1 === ROPE_N - 1 ? 0 : 0.5;
      a.addScaledVector(ropeDir, k * wa); b.addScaledVector(ropeDir, -k * wb);
    }
  }
  let path = 0;
  for (let i = 0; i < ROPE_N - 1; i++) path += ropeP[i].distanceTo(ropeP[i + 1]);
  if (path > ropeLen * 1.01 || reeling) {
    ropeDir.subVectors(ropeP[ROPE_N - 2], belt).normalize();
    const pull = reeling ? 2.6 : 0;                                   // reel speed, m/s
    const along = vel.dot(ropeDir), stretch = Math.max(0, path - ropeLen);
    if (along < pull) vel.addScaledVector(ropeDir, Math.min(pull - along, 6 * dt) + stretch * 4 * dt);
  }
  ropeFrame ^= 1; // keep it out of the hull; half the points per frame to stay cheap on the Quest
  for (let i = 1 + ropeFrame; i < ROPE_N - 1; i += 2) {
    const d = shipContact(ropeP[i], 0.05, contact);
    if (d < 0.05) ropeP[i].addScaledVector(contact.normal, 0.05 - d);
  }
  for (let i = 0; i < ROPE_N - 1; i++) {
    const a = ropeP[i], b = ropeP[i + 1];
    ropeDir.subVectors(b, a); const len = ropeDir.length();
    ropeQ.setFromUnitVectors(Y_AXIS, len > 1e-6 ? ropeDir.divideScalar(len) : Y_AXIS);
    ropeM.compose(tmp.addVectors(a, b).multiplyScalar(0.5), ropeQ, ropeScale.set(1, len + 0.01, 1));
    ropeMesh.setMatrixAt(i, ropeM);
  }
  ropeMesh.instanceMatrix.needsUpdate = true;
  clipA.position.copy(tetherClip); clipB.position.copy(belt);
  clipB.quaternion.copy(rig.quaternion);
}

// dev telemetry: every 0.5 s in VR, post head/arm poses (in your head's yaw frame: x = right, y = up, z = forward)
let teleT = 0;
function telemetry(dt) {
  teleT -= dt; if (teleT > 0) return; teleT = 0.5;
  camera.getWorldPosition(headPos); camera.getWorldQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).projectOnPlane(up).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up);
  const rel = arr => { const v = new THREE.Vector3().fromArray(arr).sub(headPos); return [v.dot(right), v.dot(up), v.dot(fwd)].map(n => +n.toFixed(3)); };
  const out = { t: +clock.elapsedTime.toFixed(1), headPitch: +Math.asin(new THREE.Vector3(0, 0, -1).applyQuaternion(q).dot(up)).toFixed(2) };
  for (const [side, h] of Object.entries(hands)) {
    const g = h.glove; if (!g?.userData.ik) continue;
    const fa = g.userData.forearm.bone, tail = new THREE.Vector3(0, FOREARM, 0).applyMatrix4(fa.matrixWorld);
    out[side + 'Info'] = { reported: h.source?.handedness, glove: g.userData.side, handTracking: !!h.source?.hand };
    out[side] = { grip: rel(h.grip.getWorldPosition(new THREE.Vector3()).toArray()), shoulder: rel(g.userData.ik.shoulder),
      elbowIK: rel(g.userData.ik.elbow), wrist: rel(g.userData.ik.wrist), sleeveEnd: rel(tail.toArray()) };
  }
  fetch('/log', { method: 'POST', body: JSON.stringify(out) }).catch(() => {});
}

function frame(fixedDt) {
  perf.begin();
  const dt = fixedDt ?? Math.min(clock.getDelta(), 0.05);
  t += dt;
  if (place === 'inside') updateControls(dt);
  if (craft) updateCraft(dt);
  updatePower(dt);
  updateRescue(dt);
  updateWarp(dt);
  if (place === 'outside') updateGear(dt);
  updateDust(dt);
  if (renderer.xr.isPresenting) {
    const holding = updateHands(dt);
    if (landedOutside()) vel.set(0, 0, 0); // on the ground: you walk, no drifting
    else if (!holding && place === 'outside') {
      if (suit.stabilizer) vel.multiplyScalar(Math.exp(-0.8 * dt));
      vel.clampLength(0, 14);
      rig.position.addScaledVector(vel, dt);
    }
    // tether: 45 m of line clipped by the airlock; the end of the line pulls you back
    const dist = place === 'outside' && !landedOutside() ? rig.position.distanceTo(tetherClip) : 0;
    if (dist > TETHER_MAX) { tmp.copy(tetherClip).sub(rig.position).normalize(); vel.addScaledVector(tmp, (dist - TETHER_MAX) * 3 * dt); }
    placeGloves();
    collide(dt);
    placeGloves();
    placeScreen();
    telemetry(dt);
    updatePoke();
    if (place === 'inside') pokeConsole();
    screenTimer -= dt; messageT -= dt;
    if (screenTimer <= 0) { drawScreen(vel.length(), dist); screenTimer = 0.15; }
  } else if (DEBUG_GLOVES) {
    rig.position.set(0, 30, 0); rig.rotation.set(0, 0, 0); camera.position.set(0, 0, 0); camera.rotation.set(-0.35, 0, 0);
    for (const g of debugGloves) aimForearm(g);
    placeScreen(); drawScreen(1.2, 3);
  } else if (place === 'inside') {
    // desktop preview of the interior: stand in the suit room and look around
    rig.position.set(interiorSpawn.x, DECK_Y + EYE_HEIGHT, interiorSpawn.z); rig.rotation.set(0, Math.sin(t * 0.25) * 1.4, 0);
    camera.position.set(0, 0, 0); camera.rotation.set(-0.12, 0, 0);
  } else {
    // desktop preview: slow orbit around the ship
    const a = t * 0.08, R = 40;
    rig.position.set(Math.sin(a) * R, 9, Math.cos(a) * R);
    rig.rotation.set(0, a, 0);
    camera.position.set(0, 0, 0); camera.rotation.set(-0.2, 0, 0);
  }
  updateRope(dt);
  updateFade(dt);
  updateInnerDoor(dt);
  updateAirlock(dt);
  tickStations(G, dt);
  if (ftlMat) { const n = UPGRADES.filter(u => u.warp && G.built[u.id]).length; ftlMat.emissiveIntensity = ftlBase * (0.15 + 0.85 * n / 4) * (n === 4 ? 1 + 0.3 * Math.sin(t * 3) : 1); }
  if (stations && place === 'inside') {
    const tips = Object.values(hands).map(h => h.glove?.userData.tip?.getWorldPosition(new THREE.Vector3())).filter(Boolean);
    stations.update(dt, tips, camera.getWorldPosition(_hp));
  }

  // world motion
  simTime += dt;
  placeSky();
  if (cockpit) updateCockpit(dt);
  updateLandCam(dt);
  if (craft) {
    const trigs = {}; if (renderer.xr.isPresenting) for (const [side, h] of Object.entries(hands)) trigs[side] = h.source?.gamepad?.buttons[0]?.value || 0;
    mining.update({ craft, body: startBody, ground: d => surface.ground(d), place, landed: craft.mode === 'LANDED', dt, heightAboveGround,
      trigs, cargoAt, dock: dockAt, powered: power.suit > 0, head: camera.getWorldPosition(_hp), headQuat: camera.getWorldQuaternion(_hq) });
  }
  bodyViews.forEach(v => { if (v.g.userData.spin) v.g.rotation.y += v.g.userData.spin * dt; });
  if (craft) {
    updateAtmosphere();
    terrainUniforms.manualSun.value = sun.visible ? 0 : 1; // only if the real sun is off
    terrainUniforms.sunDirW.value.copy(sunDir); terrainUniforms.sunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
  }
  if (exotic.userData.disk) exotic.userData.disk.rotation.z += dt * 0.15;
  if (exotic.userData.beams) exotic.userData.beams.rotation.y += dt * (exoticKind === 'pulsar' ? 4 : 0.05);
  if (exotic.userData.core && exoticKind === 'neutron') exotic.userData.core.scale.setScalar(1 + Math.sin(t * 9) * 0.08);
  ship.traverse(o => { if (o.userData.blink) o.visible = (t % 1.4) < 0.25; });
  updateExhaust(dt);
  sun.target.position.set(0, 0, 0);
  renderer.render(scene, camera);
  perf.end();
}
renderer.setAnimationLoop(() => frame());
drawScreen(0, 0);
scene.traverse(o => { if (o.material) [].concat(o.material).forEach(retro); });

// ?gloves on the desktop: pose both arms in front of the camera to check the rig, forearm IK, flame and arm screen
const DEBUG_GLOVES = params.has('gloves');
const debugGloves = [];
if (DEBUG_GLOVES) (async () => {
  const fake = (trig, sq) => ({ buttons: [{ value: trig }, { value: sq }, {}, { touched: false }, {}, {}], axes: [] });
  const right = await makeGlove('right'), left = await makeGlove('left');
  right.position.set(0.2, 29.78, -0.38); right.rotation.set(0.2, 0.5, 0.4);       // wrist cocked so the forearm has to bend
  left.position.set(-0.04, 29.8, -0.33); left.rotation.set(0, -Math.PI / 2, 0);
  scene.add(right, left); debugGloves.push(right, left);
  hands.right = { glove: right, source: {} }; hands.left = { glove: left, source: {} };
  attachFingertip();
  poseFingers(hands.right, fake(0, 0.9)); poseFingers(hands.left, fake(0.4, 0));
  setTimeout(() => { mining.shoulder(hands.left); mining.squeeze(hands.right, new THREE.Vector3(1e9, 0, 0)); }, 1500); // the pack, open
  right.userData.flame.visible = true; right.userData.heat.emissiveIntensity = 3;
  window.dbg = { wristScreen, left, right, THREE };
})();

// dev hook for desktop testing
window.nomad = { get innerDoor() { return innerDoor; }, cycleAirlock, get place() { return place; }, get hatch() { return hatch; }, ship, shipColliders, system, bodyViews, sunObj, perf, camera, rig, THREE, surface, craft, autoLand: () => craftCommand('land'), takeoff: () => craftCommand('takeoff'), hold: () => craftCommand('hold'), get seated() { return seated; }, mining, ctl, G, get stations() { return stations; }, rescue, startRescue, renderer, scene, step: (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) frame(dt); } };
