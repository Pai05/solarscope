// Pure helpers for AR measuring (no three.js, no WebXR), so they run in Node tests.
// Points are plain {x, y, z} in metres (y up); 2D polygons are [[x, z], ...].

export const MAX_RANGE_M = 5;          // refuse corners further away than this (grazing ray -> large error)
export const FLOOR_TOL_M = 0.1;        // plane hits within this of the locked floor refine it; others are ignored
export const STEADY_SPREAD_M = 0.04;   // samples of one placement must stay within this of their median
export const MIN_SAMPLES = 3;
export const SAMPLE_WINDOW_MS = 500;   // look at this much aiming time before the press...
export const PRESS_JOLT_MS = 100;      // ...ignoring the last moment, when the finger already shakes the phone
export const LEVEL_WARN_M = 0.3;       // a corner this far above/below the first one is probably not on the floor
export const DRIFT_WARN_M = 0.08;      // smaller level offsets on a flat roof mean the phone's tracking drifted
export const CAM_JUMP_M = 0.25;        // camera moving this far between two frames = tracking jumped (relocalized)

// Classify a new corner's height relative to the first corner of the scan.
export function levelProblem(levelOff) {
  const a = Math.abs(levelOff);
  if (a > LEVEL_WARN_M) return "offfloor";
  if (a > DRIFT_WARN_M) return "drift";
  return null;
}

const median = (vals) => {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// Robust position of one placement from the ring positions recorded while the user aimed.
// samples: [{t, p: {x, y, z}, kind}], pressT: time of the press.
// Uses only samples of the most recent surface kind (plane hits and feature-point hits are not mixed),
// takes the per-axis median (one-frame jumps do not pull it) and reports how steady the aim was.
// Returns null when there are too few samples.
export function robustPoint(samples, pressT, opts = {}) {
  const windowMs = opts.windowMs ?? SAMPLE_WINDOW_MS;
  const joltMs = opts.joltMs ?? PRESS_JOLT_MS;
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const before = samples.filter((s) => s.t <= pressT - joltMs);
  // Tracking may have flickered just before the press: end the window at the last sample instead.
  const pool = before.length ? before : samples.filter((s) => s.t <= pressT);
  if (!pool.length) return null;
  const endT = pool[pool.length - 1].t;
  const kind = pool[pool.length - 1].kind;
  const win = pool.filter((s) => s.t >= endT - windowMs && s.kind === kind);
  if (win.length < minSamples) return null;
  const p = {
    x: median(win.map((s) => s.p.x)),
    y: median(win.map((s) => s.p.y)),
    z: median(win.map((s) => s.p.z)),
  };
  // 80th percentile of horizontal deviation from the median: ignores a stray frame, catches a moving aim.
  const dev = win.map((s) => horizontalDistance(s.p, p)).sort((a, b) => a - b);
  const spread = dev[Math.min(dev.length - 1, Math.floor(dev.length * 0.8))];
  return { p, spread, n: win.length, kind };
}

// Why a placement should be refused, or null if it is fine.
// cam: camera position {x, y, z} at the press (null if unknown).
export function placementProblem(est, cam, opts = {}) {
  const maxRange = opts.maxRange ?? MAX_RANGE_M;
  const maxSpread = opts.maxSpread ?? STEADY_SPREAD_M;
  if (!est) return { code: "nodata", text: "Hold the ring on the corner for a moment, then press again." };
  if (cam) {
    const d = horizontalDistance(est.p, cam);
    if (d > maxRange) {
      return { code: "far", text: `That corner is ${d.toFixed(1)} m away. Walk closer (within ${maxRange} m) for an accurate point.` };
    }
  }
  if (est.spread > maxSpread) {
    return { code: "shaky", text: "The ring was moving. Hold the phone still on the corner for half a second, then press." };
  }
  return null;
}

// Locked floor: where the camera's centre ray meets the horizontal plane y = floorY.
// cam {x, y, z} and dir {x, y, z} (unit vector) in the AR reference space. Works beyond the patch of floor
// ARCore has detected, and cannot jump onto a wrong plane. Null when the ray does not point down at the
// floor, or meets it further than limit metres away (horizontally).
export function floorFromRay(cam, dir, floorY, limit = 3 * MAX_RANGE_M) {
  if (dir.y > -0.02 || cam.y <= floorY) return null;
  const t = (floorY - cam.y) / dir.y;
  const p = { x: cam.x + dir.x * t, y: floorY, z: cam.z + dir.z * t };
  return horizontalDistance(p, cam) <= limit ? p : null;
}

// Slowly follow ARCore's floor estimate (tracking drifts a little in height), ignoring planes that are
// clearly another surface or a mis-detection (seen 40-60 cm off in phone logs).
export function refineFloor(floorY, hitY, tol = FLOOR_TOL_M, rate = 0.05) {
  return Math.abs(hitY - floorY) <= tol ? floorY + rate * (hitY - floorY) : floorY;
}

// Segment intersection (proper crossings only; shared endpoints do not count).
function segmentsCross([ax, az], [bx, bz], [cx, cz], [dx, dz]) {
  const o = (px, pz, qx, qz, rx, rz) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  const o1 = o(ax, az, bx, bz, cx, cz), o2 = o(ax, az, bx, bz, dx, dz);
  const o3 = o(cx, cz, dx, dz, ax, az), o4 = o(cx, cz, dx, dz, bx, bz);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

// True if any two non-adjacent edges of the closed polygon cross (corners tapped out of order).
export function selfIntersects(pts) {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;  // adjacent edges share a corner
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Indices of pts sorted by angle around their centroid: the order a person walking around the shape
// would tap them. Used when taps came out of order (crossing edges); right for convex shapes such as
// tanks and stair rooms, and for any shape every corner of which is visible from its centre.
export function orderAroundCentre(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map((p, i) => [Math.atan2(p[1] - cz, p[0] - cx), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
}

// Edge lengths of a closed polygon, for the readout and the diagnostics log.
export function edgeLengths(pts) {
  return pts.map(([x1, z1], i) => {
    const [x2, z2] = pts[(i + 1) % pts.length];
    return Math.hypot(x2 - x1, z2 - z1);
  });
}
