// AR measuring with WebXR (immersive-ar + hit-test + dom-overlay, optional anchors), three.js r160.
// Works in Chrome on ARCore Android phones over HTTPS (or an origin Chrome is told to treat as secure).
//
// Two modes:
//   length (image page, #arBtn): tap the ends of one wall (extra taps = segments), save, repeat ~3x,
//          "Use median" -> fills the calibration box of the image page.
//   area   (scan page, #arScanBtn): tap every corner of the roof / house footprint, "Close shape",
//          optionally "Add obstruction" and tap around each tank or stair room, "Finish" ->
//          the shapes go to the floor plan (plan.js) which lays out panels.
// Points are taken on detected surfaces (floor / ground). Coordinates returned in metres as [x, z]:
// a top-down view with x to the right and z towards the user.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import {
  robustPoint, placementProblem, selfIntersects, orderAroundCentre, edgeLengths, horizontalDistance,
  levelProblem, floorFromRay, refineFloor, MAX_RANGE_M, CAM_JUMP_M,
} from "./ar-geometry.js";

const WALK_TIP = `Tap every corner you can see within ${MAX_RANGE_M} m from where you stand: less walking, less drift. `
  + "If you must walk, go slowly with the camera looking at the floor 1-2 m ahead, not straight down.";

const $ = (s) => document.querySelector(s);
const SPREAD_WARN = 0.03;  // warn when repeated lengths differ by more than 3% of the median
const COLORS = { length: 0xf59e0b, roof: 0x22c55e, obstruction: 0xef4444 };

// ---------- pure helpers (exported for tests) ----------

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
  return total;
}

export function summarize(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const halfRange = (s[s.length - 1] - s[0]) / 2;
  return { median, halfRange, relSpread: median > 0 ? halfRange / median : 0, n: s.length };
}

// Shoelace area of a polygon given as [[x, z], ...] (metres) -> m2.
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, z2 - z1);
  }
  return p;
}

const flat = (v) => [v.x, v.z];  // horizontal projection

// The readouts refresh every frame; touching the DOM only on change keeps the AR frame rate up.
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHTML = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };

// ---------- availability ----------

async function availability() {
  if (!window.isSecureContext) return "insecure";
  if (!navigator.xr) return "unsupported";
  try {
    return (await navigator.xr.isSessionSupported("immersive-ar")) ? "ok" : "unsupported";
  } catch (_) {
    return "unsupported";
  }
}

const REASONS = {
  insecure: "AR needs a secure (https://) address for this site.",
  unsupported: "AR needs Chrome on an Android phone with ARCore (Google Play Services for AR).",
};

// ---------- diagnostics: shown in the AR screen and sent to the server log (/client-log) ----------

const DIAG = [];
function diag(text) {
  const line = `${new Date().toISOString().slice(11, 19)} ${text}`;
  DIAG.push(line);
  const el = $("#arDebug");
  if (el) el.textContent = DIAG.slice(-2).join("\n");
  fetch("/client-log", { method: "POST", body: line.slice(0, 500) }).catch(() => {});
}
window.addEventListener("error", (e) => diag(`JS error: ${e.message} @${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => diag(`Promise error: ${e.reason?.message || e.reason}`));

// ---------- AR session ----------

async function startAR(mode) {
  const overlay = $("#arOverlay");
  overlay.hidden = false;  // dom-overlay root must be displayed when the session starts
  if (!$("#arDebug")) {
    const d = document.createElement("div");
    d.id = "arDebug";
    d.className = "ar-debug";
    overlay.querySelector(".ar-top").appendChild(d);
  }
  diag(`startAR ${mode}`);
  let session;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "dom-overlay"],
      optionalFeatures: ["anchors"],
      domOverlay: { root: overlay },
    });
    diag(`session ok, domOverlay=${session.domOverlayState?.type || "?"}`);
  } catch (e) {
    overlay.hidden = true;
    diag(`requestSession failed: ${e.name} ${e.message}`);
    window.setStatus?.(`Could not start AR: ${e.message}`, "error");
    return;
  }

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local");
  renderer.domElement.style.display = "none";
  document.body.appendChild(renderer.domElement);
  await renderer.xr.setSession(session);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);
  const dotGeo = new THREE.SphereGeometry(0.03, 16, 12);
  const reticlePos = new THREE.Vector3();
  let hit = null;
  // Recent ring positions while the surface is tracked. A placed point is the median of the ones the
  // user held on the corner just before pressing (see robustPoint). The last good hit stays usable for
  // HOLD_MS, so a one-frame tracking flicker while pressing the button does not swallow the press.
  const recent = [];
  const KEEP_MS = 2000;
  const HOLD_MS = 1500;
  let lastHit = null, lastHitT = -1e9;
  let camPos = null;  // phone position in the reference space, for the distance-to-corner check
  let camDir = null;  // direction of the crosshair ray (screen centre)
  // Floor height, locked at the first placed point. From then on the ring sits where the crosshair ray
  // meets that flat floor, instead of on whatever plane ARCore hits first: it reaches beyond the mapped
  // patch of floor and never jumps onto a false plane.
  let floorY = null;
  const ray = new THREE.Vector3();
  const stats = { frames: 0, hitFrames: 0, selects: 0, presses: 0, placed: 0, tracked: 0, emulated: 0, rawResults: 0 };

  let hitSource, pointSource = null;
  let hitKind = "";  // "plane" | "point" for the current / last good hit
  try {
    const viewerSpace = await session.requestReferenceSpace("viewer");
    hitSource = await session.requestHitTestSource({ space: viewerSpace });  // default: planes
    diag("hit-test source ok");
    // Fallback for phones / floors where ARCore never forms a plane: hits on tracked feature points
    // (real textured spots on the surface). Used only in frames without a plane hit.
    try {
      pointSource = await session.requestHitTestSource({ space: viewerSpace, entityTypes: ["point"] });
      diag("feature-point hit-test source ok");
    } catch (e) {
      diag(`feature-point hit-test unavailable: ${e.name} ${e.message}`);
    }
  } catch (e) {
    diag(`hit-test source failed: ${e.name} ${e.message}`);
    $("#arMsg").textContent = `Surface detection could not start (${e.message}). Update "Google Play Services for AR" and Chrome.`;
    setTimeout(() => session.end().catch(() => {}), 6000);
    return;
  }

  // A shape is an open or closed polyline of anchored points.
  function newShape(kind) {
    const color = COLORS[kind];
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }));
    scene.add(line);
    return { kind, points: [], closed: false, line, dotMat: new THREE.MeshBasicMaterial({ color }) };
  }
  function addPoint(shape, est) {
    const p = {
      pos: new THREE.Vector3(est.p.x, est.p.y, est.p.z),
      mesh: new THREE.Mesh(dotGeo, shape.dotMat),
      needsAnchor: true,  // anchored at this exact position in the next frame (pins it against drift)
      placedAt: new THREE.Vector3(est.p.x, est.p.y, est.p.z),  // to log how far the anchor moved it
    };
    p.mesh.position.copy(p.pos);
    scene.add(p.mesh);
    shape.points.push(p);
  }
  function popPoint(shape) {
    const p = shape.points.pop();
    if (p) { scene.remove(p.mesh); p.anchor?.delete?.(); }
  }
  function drawShape(shape, withReticle) {
    const pts = shape.points.map((p) => p.pos);
    if (withReticle && reticle.visible && !shape.closed && pts.length) pts.push(reticlePos.clone());
    if (shape.closed && pts.length) pts.push(pts[0]);
    shape.line.geometry.setFromPoints(pts);
  }
  function removeShape(shape) {
    while (shape.points.length) popPoint(shape);
    scene.remove(shape.line);
  }

  const msg = $("#arMsg"), live = $("#arLive"), list = $("#arList"), buttons = $("#arButtons");
  msg.textContent = "Move the phone slowly over the ground until the white ring appears.";
  const btn = (id, label, cls = "") => `<button id="${id}" class="${cls}">${label}</button>`;
  // Crosshair at the screen centre (where the hit-test ray points) and a surface-tracking indicator.
  if (!overlay.querySelector(".ar-crosshair")) {
    const c = document.createElement("div");
    c.className = "ar-crosshair";
    overlay.appendChild(c);
  }
  let track = $("#arTrack");
  if (!track) {
    track = document.createElement("div");
    track.id = "arTrack";
    track.className = "ar-track";
    overlay.querySelector(".ar-top").prepend(track);
  }
  const placeBtn = btn("arPlace", "＋ Place point", "place");
  const end = (callback) => {
    session.end().catch(() => {});
    callback?.();
  };

  let current;          // shape being drawn
  const closed = [];    // area mode: closed shapes (first is the roof)
  const lengths = [];   // length mode: saved lengths

  let ui;  // refresh function for the mode's readouts and buttons
  if (mode === "length") {
    current = newShape("length");
    buttons.innerHTML = placeBtn + btn("arUndo", "Undo", "secondary") + btn("arFinish", "Save length")
      + btn("arDone", "Use median") + btn("arExit", "Cancel", "secondary");
    ui = () => {
      const pts = current.points.map((p) => p.pos);
      const toRet = reticle.visible && pts.length ? reticlePos.distanceTo(pts[pts.length - 1]) : 0;
      setText(live, pts.length ? `${(polylineLength(pts) + toRet).toFixed(2)} m` : "–");
      const s = summarize(lengths);
      setHTML(list, s
        ? `Saved: ${lengths.map((v) => v.toFixed(2)).join(", ")} m<br>Median <b>${s.median.toFixed(2)} m</b> ± ${s.halfRange.toFixed(2)}`
          + (s.n > 1 && s.relSpread > SPREAD_WARN ? ' <span class="ar-warn">repeats disagree, measure again</span>' : "")
        : "Measure the same wall 3 times for a reliable median.");
      $("#arDone").disabled = !lengths.length;
      $("#arFinish").disabled = pts.length < 2;
      $("#arUndo").disabled = !pts.length;
    };
    $("#arUndo").onclick = () => { popPoint(current); ui(); };
    $("#arFinish").onclick = () => {
      if (current.points.length < 2) return;
      lengths.push(polylineLength(current.points.map((p) => p.pos)));
      diag(`length saved ${lengths[lengths.length - 1].toFixed(3)} m (${current.points.length} points)`);
      while (current.points.length) popPoint(current);
      msg.textContent = lengths.length < 3 ? "Saved. Measure the same wall again." : "Saved. Press Use median.";
      ui();
    };
    $("#arDone").onclick = () => {
      const s = summarize(lengths);
      if (s) end(() => window.SolarScopeApplyARLength?.({ ...s, values: [...lengths] }));
    };
  } else {
    current = newShape("roof");
    buttons.innerHTML = placeBtn + btn("arUndo", "Undo", "secondary") + btn("arClose", "Close shape")
      + btn("arObs", "+ Obstruction", "secondary") + btn("arFinishArea", "Finish")
      + btn("arExit", "Cancel", "secondary");
    const roofDone = () => closed.length > 0;
    ui = () => {
      const pts = current ? current.points.map((p) => flat(p.pos)) : [];
      const tentative = reticle.visible && current ? [...pts, flat(reticlePos)] : pts;
      const label = current?.kind === "obstruction" ? "Obstruction" : "Roof";
      if (current && pts.length) {
        const area = tentative.length >= 3 ? ` · ${polygonArea(tentative).toFixed(1)} m²` : "";
        const edge = reticle.visible ? reticlePos.distanceTo(current.points[current.points.length - 1].pos) : 0;
        setText(live, `${label}: edge ${edge.toFixed(2)} m${area}`);
      } else {
        setText(live, roofDone() ? "–" : "Tap the first corner");
      }
      const roof = closed[0];
      const parts = [];
      if (roof) {
        const r = roof.points.map((p) => flat(p.pos));
        parts.push(`Roof <b>${polygonArea(r).toFixed(1)} m²</b>, perimeter ${polygonPerimeter(r).toFixed(1)} m`);
      }
      const obs = closed.slice(1);
      if (obs.length) {
        const oa = obs.reduce((s, o) => s + polygonArea(o.points.map((p) => flat(p.pos))), 0);
        parts.push(`${obs.length} obstruction${obs.length > 1 ? "s" : ""}, ${oa.toFixed(1)} m²`);
      }
      setHTML(list, parts.join("<br>") || "Tap each corner of the roof (or of the house at ground level) in order.");
      $("#arUndo").disabled = !(current?.points.length || closed.length);
      $("#arClose").disabled = !(current && current.points.length >= 3);
      $("#arObs").disabled = !roofDone() || (current && current.points.length > 0);
      $("#arFinishArea").disabled = !roofDone();
    };
    // Returns false if the shape cannot be closed, "reordered" if its corners had to be put in order.
    const closeCurrent = () => {
      if (!current || current.points.length < 3) return false;
      let result = true;
      if (selfIntersects(current.points.map((p) => flat(p.pos)))) {
        // Corners tapped out of order make a bow-tie whose area is wrong. Easy on a small tank or a stair
        // room whose back corners are hard to see: put them in order around the shape's centre.
        const order = orderAroundCentre(current.points.map((p) => flat(p.pos)));
        const reordered = order.map((i) => current.points[i]);
        if (selfIntersects(reordered.map((p) => flat(p.pos)))) {
          msg.textContent = "The edges cross: the corners were not tapped in order around the shape. "
            + "Press Undo back to the wrong corner and tap them in order.";
          diag(`close refused: self-intersecting ${current.kind}, reordering did not help`);
          return false;
        }
        current.points = reordered;
        diag(`close: ${current.kind} corners reordered (${order.join(",")})`);
        result = "reordered";
      }
      current.closed = true;
      drawShape(current, false);
      closed.push(current);
      current = null;
      return result;
    };
    $("#arClose").onclick = () => {
      const wasRoof = current?.kind === "roof";
      const done = closeCurrent();
      if (!done) return;
      msg.textContent = (done === "reordered" ? "Corners were tapped out of order, so I put them in order around the shape. " : "")
        + (wasRoof
          ? "Roof captured. Add obstructions (water tank, stair room) or press Finish."
          : "Obstruction added. Add another or press Finish.");
      ui();
    };
    $("#arObs").onclick = () => {
      current = newShape("obstruction");
      msg.textContent = "Tap at least 3 corners of the obstruction where it meets the floor (any order), then Close shape. "
        + "For a round tank, tap 4 or more points around its base.";
      ui();
    };
    $("#arUndo").onclick = () => {
      if (current && current.points.length) popPoint(current);
      else if (closed.length) {  // reopen the last closed shape
        if (current) removeShape(current);
        current = closed.pop();
        current.closed = false;
      }
      ui();
    };
    $("#arFinishArea").onclick = () => {
      if (current?.kind === "obstruction" && current.points.length > 0 && current.points.length < 3) {
        // Do not drop a half-tapped obstruction silently.
        const k = current.points.length;
        msg.textContent = `This obstruction has only ${k} corner${k > 1 ? "s" : ""}: tap at least 3 `
          + "(then Close shape), or press Undo to remove it, then Finish.";
        diag(`finish refused: obstruction with ${k} points`);
        return;
      }
      if (current && current.points.length >= 3 && !closeCurrent()) return;
      if (!closed.length) return;
      const shapes = closed.map((s) => s.points.map((p) => flat(p.pos)));
      const moved = closed.flatMap((s) => s.points.map((p) => p.pos.distanceTo(p.placedAt)));
      diag(`area result: roof ${polygonArea(shapes[0]).toFixed(2)} m2, edges `
        + `${edgeLengths(shapes[0]).map((e) => e.toFixed(2)).join("/")} m, ${shapes.length - 1} obstructions, `
        + `anchored ${closed.flatMap((s) => s.points).filter((p) => p.anchor).length}/${moved.length}, `
        + `max anchor correction ${(Math.max(0, ...moved) * 100).toFixed(1)} cm, anchors api ${!!session.enabledFeatures?.includes?.("anchors")}`);
      const result = { roof: shapes[0], obstructions: shapes.slice(1) };
      end(() => window.SolarScopeApplyARArea?.(result));
    };
  }
  $("#arExit").onclick = () => end(null);

  // Taps on the camera view add a point at the ring; taps on overlay buttons must not.
  for (const el of overlay.querySelectorAll(".ar-panel")) {
    el.addEventListener("beforexrselect", (e) => e.preventDefault());
  }
  function placePoint(ev) {
    if (ev?.type === "select") stats.selects++; else stats.presses++;
    if (!current) { diag("place: no open shape (press Add obstruction or Undo)"); return; }
    const now = performance.now();
    if (!lastHit || now - lastHitT > HOLD_MS) {
      diag(`place: no surface (hits ${stats.hitFrames}/${stats.frames} frames)`);
      msg.textContent = "No floor under the crosshair yet. Move the phone slowly over a textured, well-lit floor.";
      return;
    }
    const est = robustPoint(recent, now);
    const problem = placementProblem(est, camPos);
    const dist = est && camPos ? horizontalDistance(est.p, camPos) : NaN;
    if (problem) {
      stats.refused = (stats.refused || 0) + 1;
      diag(`place refused (${problem.code}): dist ${dist.toFixed(2)} m, spread ${est ? (est.spread * 100).toFixed(1) : "-"} cm, n ${est?.n ?? 0}`);
      msg.textContent = problem.text;
      navigator.vibrate?.([20, 60, 20]);
      return;
    }
    // Corners of one roof lie on one floor; a much higher or lower hit landed on a parapet, tank or step.
    const ref0 = (mode === "length" ? current : closed[0] || current).points[0];
    const levelOff = ref0 ? est.p.y - ref0.pos.y : 0;
    addPoint(current, est);
    stats.placed++;
    if (floorY === null && est.kind === "plane") {
      floorY = est.p.y;
      diag(`floor locked at y ${floorY.toFixed(3)} m (camera ${camPos ? (camPos.y - floorY).toFixed(2) : "?"} m above it)`);
    }
    diag(`placed point ${current.points.length} (${current.kind}) via ${est.kind}: dist ${dist.toFixed(2)} m, `
      + `spread ${(est.spread * 100).toFixed(1)} cm, n ${est.n}, level ${levelOff >= 0 ? "+" : ""}${levelOff.toFixed(2)} m`);
    navigator.vibrate?.(30);
    const n = current.points.length;
    const level = levelProblem(levelOff);
    const offCm = Math.round(Math.abs(levelOff) * 100);
    if (level === "offfloor") {
      msg.textContent = `This point is ${offCm} cm ${levelOff > 0 ? "above" : "below"} the first corner: `
        + "it may be on a wall, tank or step, not the floor. Undo it if the ring was not on the floor.";
    } else if (level === "drift") {
      // On a flat floor this means the phone lost track of where it is; the corner is off sideways too.
      stats.drift = (stats.drift || 0) + 1;
      msg.textContent = `⚠ Tracking drifted (the floor seems ${offCm} cm ${levelOff > 0 ? "higher" : "lower"} here), `
        + "so this corner may be off. Press Undo, walk back to the last corner slowly, then come here again. " + WALK_TIP;
    } else if (mode === "length") {
      msg.textContent = n === 1 ? "Walk along the wall to its other end and place a point. " + WALK_TIP
        : "Place more points, or press Save length.";
    } else {
      msg.textContent = n < 3 ? WALK_TIP : "Next corner, or Close shape after the last one. " + WALK_TIP;
    }
    ui();
  }
  $("#arPlace").onclick = placePoint;
  session.addEventListener("select", placePoint);  // tapping the camera view also places a point
  ui();

  let lastReport = performance.now();
  const t0 = lastReport;
  renderer.setAnimationLoop((_, frame) => {
    if (!frame) return;
    stats.frames++;
    const now = performance.now();
    const ref = renderer.xr.getReferenceSpace();
    const viewerPose = frame.getViewerPose(ref);  // null = the phone is not tracking its own position
    if (viewerPose) {
      stats.tracked++;
      if (viewerPose.emulatedPosition) stats.emulated++;
      const p = viewerPose.transform.position;
      if (camPos && Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z) > CAM_JUMP_M) {
        // Nobody moves a phone 25 cm in one frame: ARCore re-estimated where it is.
        stats.jumps = (stats.jumps || 0) + 1;
        diag(`tracking jump ${Math.hypot(p.x - camPos.x, p.z - camPos.z).toFixed(2)} m`);
        if (current?.points.length || closed.length) {
          msg.textContent = "⚠ The phone's tracking jumped. Check that the dots still sit on the corners; "
            + "if not, Undo them and measure again. " + WALK_TIP;
        }
      }
      camPos = p;
      const q = viewerPose.transform.orientation;
      ray.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      camDir = { x: ray.x, y: ray.y, z: ray.z };
    } else {
      camDir = null;
    }
    let results = frame.getHitTestResults(hitSource);
    let kind = "plane";
    let found = null;  // {x, y, z} of the ring this frame
    if (floorY === null) {
      if (!results.length && pointSource) {  // fallback only when no plane is hit this frame
        results = frame.getHitTestResults(pointSource);
        kind = "point";
        if (results.length) stats.pointHits = (stats.pointHits || 0) + 1;
      }
      if (results.length) stats.rawResults++;
      const pose = results.length ? results[0].getPose(ref) : null;
      if (pose) found = pose.transform.position;
    } else {
      // Floor locked: let ARCore's planes near that height refine it, ignore the rest, and put the ring
      // where the crosshair ray meets the floor.
      for (const r of results) {
        const y = r.getPose(ref)?.transform.position.y;
        if (y === undefined) continue;
        const next = refineFloor(floorY, y);
        if (next === floorY) stats.falsePlanes = (stats.falsePlanes || 0) + 1;
        floorY = next;
      }
      if (results.length) stats.rawResults++;
      kind = "floor";
      found = camPos && camDir ? floorFromRay(camPos, camDir, floorY) : null;
    }
    if (found) hitKind = kind;
    if (found) {
      stats.hitFrames++;
      hit = found;
      lastHit = hit;
      lastHitT = now;
      reticle.visible = true;
      reticlePos.set(found.x, found.y, found.z);
      reticle.matrix.makeTranslation(found.x, found.y, found.z);  // ring geometry is already flat
      recent.push({ t: now, p: { x: found.x, y: found.y, z: found.z }, kind });
      if (msg.textContent.startsWith("Move")) msg.textContent = "Aim the crosshair at a corner on the ground, hold steady, press Place point.";
    } else {
      hit = null;
      reticle.visible = false;
    }
    while (recent.length && now - recent[0].t > KEEP_MS) recent.shift();
    const usable = now - lastHitT <= HOLD_MS;
    const kindLabel = { floor: "floor locked", plane: "floor plane", point: "feature point (less precise)" }[hitKind] || "";
    const away = hit && camPos ? horizontalDistance(reticlePos, camPos) : NaN;
    const far = away > MAX_RANGE_M;
    const awayText = Number.isFinite(away) ? ` · ${away.toFixed(1)} m away` : "";
    const trackText = far ? `⚠ Too far (${away.toFixed(1)} m): walk within ${MAX_RANGE_M} m of the corner`
      : hit ? `● Surface found: ${kindLabel}${awayText}`
      : usable ? `● Surface found (hold steady): ${kindLabel}` : "○ Searching for the floor… move slowly";
    if (track.textContent !== trackText) track.textContent = trackText;
    track.classList.toggle("ok", usable && !far);
    // Everything undone: unlock the floor so a wrong first point does not stay the reference.
    if (floorY !== null && ![...closed, current].some((s) => s?.points.length)) {
      floorY = null;
      diag("floor unlocked (no points left)");
    }
    // Anchor newly placed points where they were placed; ARCore then keeps them in place as its map
    // of the room is refined, so walking around the roof does not shift earlier corners.
    if (frame.createAnchor) {
      for (const shape of [...closed, current].filter(Boolean)) {
        for (const p of shape.points) {
          if (!p.needsAnchor) continue;
          p.needsAnchor = false;
          const t = new XRRigidTransform({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
          frame.createAnchor(t, ref).then((a) => {
            stats.anchors = (stats.anchors || 0) + 1;
            if (shape.points.includes(p)) p.anchor = a; else a.delete?.();  // undone meanwhile
          }).catch((e) => {
            stats.anchorFail = (stats.anchorFail || 0) + 1;
            diag(`anchor failed: ${e.message}`);
          });
        }
      }
    }
    $("#arPlace").disabled = !current;  // never disabled by tracking flicker; placePoint explains if no surface
    if (now - lastReport > (now - t0 < 30000 ? 3000 : 10000)) {
      lastReport = now;
      diag(`frames ${stats.frames}, tracked ${stats.tracked} (emulated ${stats.emulated}), hit results ${stats.rawResults}, `
        + `surface hits ${stats.hitFrames} (feature-point ${stats.pointHits || 0}), presses ${stats.presses}, taps ${stats.selects}, placed ${stats.placed}`);
      if (stats.frames > 150 && !stats.tracked) {
        track.textContent = "○ Phone is not tracking: check ARCore / camera";
      }
    }
    for (const shape of [...closed, current].filter(Boolean)) {
      for (const p of shape.points) {
        if (!p.anchor) continue;
        const ap = frame.getPose(p.anchor.anchorSpace, ref);
        if (ap) { p.pos.set(ap.transform.position.x, ap.transform.position.y, ap.transform.position.z); p.mesh.position.copy(p.pos); }
      }
      drawShape(shape, shape === current);
    }
    ui();
    renderer.render(scene, camera);
  });

  session.addEventListener("end", () => {
    diag(`session end: ${JSON.stringify(stats)}`);
    renderer.setAnimationLoop(null);
    hitSource.cancel?.();
    pointSource?.cancel?.();
    renderer.dispose();
    renderer.domElement.remove();
    overlay.hidden = true;
  });
}

// ---------- wire up ----------

// AR not available: say why in plain words and offer the manual way, with a button that jumps to it.
function showFallback(note, reason, mode, target) {
  note.classList.add("is-warn");
  note.textContent = "";
  const title = document.createElement("strong");
  title.textContent = "AR is not available on this device.";
  const why = document.createElement("span");
  why.textContent = reason + (mode === "area"
    ? " No problem: type the roof length and width instead."
    : " No problem: type the scale, or draw a tape-measured length on the image with Calibrate.");
  note.append(title, why);
  if (!target) return;
  const go = document.createElement("button");
  go.type = "button";
  go.className = "secondary note-action";
  go.textContent = mode === "area" ? "Type the roof size instead" : "Type the scale instead";
  go.addEventListener("click", () => {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  });
  note.append(go);
}

async function init() {
  const pairs = [["#arBtn", "length"], ["#arScanBtn", "area"]];
  const a = await availability();
  if ($("#arBtn") || $("#arScanBtn")) {
    diag(`page ${location.pathname}: AR=${a}, secure=${window.isSecureContext}, xr=${!!navigator.xr}, ua=${navigator.userAgent.slice(0, 120)}`);
  }
  for (const [sel, mode] of pairs) {
    const button = $(sel);
    if (!button) continue;
    const note = $(button.dataset.note);
    if (a === "ok") {
      button.disabled = false;
      if (note) note.textContent = mode === "length"
        ? "Stand by the house wall; tap where it meets the ground at both corners."
        : "Ready. Walk to the first corner of the roof (or of the house) and start.";
      button.addEventListener("click", () => startAR(mode));
    } else {
      button.disabled = true;
      if (note) showFallback(note, REASONS[a], mode, $(button.dataset.fallback));
    }
  }
}

init();
