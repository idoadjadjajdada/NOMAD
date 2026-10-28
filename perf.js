// Frame pacing + render stats. begin()/end() wrap the frame; stats refresh once a second.
// In VR a summary goes to /log every 2 s, so a Quest run can be read on the Mac (telemetry.jsonl, ev "perf").
const N = 240;
export function createPerf(renderer, context) {
  const gaps = new Float32Array(N), sorted = new Float32Array(N);
  let i = 0, n = 0, last = 0, t0 = 0, cpuSum = 0, frames = 0, statStart = 0, logT = 0;
  const stats = { fps: 0, avgMs: 0, p95Ms: 0, worstMs: 0, missed: 0, cpuMs: 0, calls: 0, tris: 0, geometries: 0, textures: 0, heapMB: 0, targetHz: 0 };
  return {
    stats,
    begin() {
      t0 = performance.now();
      if (last) { gaps[i] = t0 - last; i = (i + 1) % N; n = Math.min(n + 1, N); }
      last = t0;
    },
    end() { // call right after renderer.render, while renderer.info still holds this frame
      cpuSum += performance.now() - t0; frames++;
      stats.calls = renderer.info.render.calls; stats.tris = renderer.info.render.triangles;
      if (t0 - statStart < 1000 || !n) return; // wall clock, not the game's clamped dt
      const session = renderer.xr.getSession();
      stats.targetHz = session?.frameRate || 0;
      const budget = 1000 / (stats.targetHz || 60);
      sorted.set(gaps); const s = sorted.subarray(0, n).sort();
      let sum = 0, missed = 0;
      for (let k = 0; k < n; k++) { sum += s[k]; if (s[k] > budget * 1.5) missed++; }
      Object.assign(stats, { fps: Math.round(1000 / (sum / n)), avgMs: +(sum / n).toFixed(1), p95Ms: +s[Math.floor(n * 0.95)].toFixed(1),
        worstMs: +s[n - 1].toFixed(1), missed, cpuMs: +(cpuSum / frames).toFixed(2),
        geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0 });
      statStart = t0; cpuSum = 0; frames = 0;
      if (session && (logT += 1) >= 2) {
        logT = 0;
        fetch('/log', { method: 'POST', body: JSON.stringify({ ev: 'perf', ...context(), ...stats,
          supportedHz: session.supportedFrameRates ? [...session.supportedFrameRates] : null }) }).catch(() => {});
      }
    },
    text() {
      const s = stats;
      return `${s.fps} fps  avg ${s.avgMs} / p95 ${s.p95Ms} / worst ${s.worstMs} ms  missed ${s.missed}/${n}  cpu ${s.cpuMs} ms  ` +
        `${s.calls} draws  ${(s.tris / 1000).toFixed(1)}k tris  ${s.geometries} geo  ${s.textures} tex${s.heapMB ? `  ${s.heapMB} MB heap` : ''}`;
    },
  };
}
