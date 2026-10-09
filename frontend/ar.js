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
  // Recent ring positions while the surface is tracked; a placed point is their average (less hand shake).
  // The last good hit stays usable for HOLD_MS, so a one-frame tracking flicker while pressing the
  // button does not swallow the press.
  const recent = [];
  const STEADY_MS = 400;
  const HOLD_MS = 1500;
  let lastHit = null, lastHitT = -1e9;
  const stats = { frames: 0, hitFrames: 0, selects: 0, presses: 0, placed: 0, tracked: 0, emulated: 0, rawResults: 0 };

  let hitSource;
  try {
    const viewerSpace = await session.requestReferenceSpace("viewer");
    hitSource = await session.requestHitTestSource({ space: viewerSpace });
    diag("hit-test source ok");
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
  function steadyPosition() {
    // Average of the ring positions in the STEADY_MS before the last good hit.
    const pts = recent.filter((r) => r.t >= lastHitT - STEADY_MS);
    if (!pts.length) return reticlePos.clone();
    const avg = new THREE.Vector3();
    for (const r of pts) avg.add(r.p);
    return avg.divideScalar(pts.length);
  }
  function addPoint(shape) {
    const p = { pos: steadyPosition(), mesh: new THREE.Mesh(dotGeo, shape.dotMat) };
    p.mesh.position.copy(p.pos);
    scene.add(p.mesh);
    shape.points.push(p);
    try {  // pin against drift; optional, placement works without it
      lastHit?.createAnchor?.()?.then((a) => { p.anchor = a; }).catch(() => {});
    } catch (_) { /* stale hit result */ }
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
      live.textContent = pts.length ? `${(polylineLength(pts) + toRet).toFixed(2)} m` : "–";
      const s = summarize(lengths);
      list.innerHTML = s
        ? `Saved: ${lengths.map((v) => v.toFixed(2)).join(", ")} m<br>Median <b>${s.median.toFixed(2)} m</b> ± ${s.halfRange.toFixed(2)}`
          + (s.n > 1 && s.relSpread > SPREAD_WARN ? ' <span class="ar-warn">repeats disagree, measure again</span>' : "")
        : "Measure the same wall 3 times for a reliable median.";
      $("#arDone").disabled = !lengths.length;
      $("#arFinish").disabled = pts.length < 2;
      $("#arUndo").disabled = !pts.length;
    };
    $("#arUndo").onclick = () => { popPoint(current); ui(); };
    $("#arFinish").onclick = () => {
      if (current.points.length < 2) return;
      lengths.push(polylineLength(current.points.map((p) => p.pos)));
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
        live.textContent = `${label}: edge ${edge.toFixed(2)} m${area}`;
      } else {
        live.textContent = roofDone() ? "–" : "Tap the first corner";
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
      list.innerHTML = parts.join("<br>") || "Tap each corner of the roof (or of the house at ground level) in order.";
      $("#arUndo").disabled = !(current?.points.length || closed.length);
      $("#arClose").disabled = !(current && current.points.length >= 3);
      $("#arObs").disabled = !roofDone() || (current && current.points.length > 0);
      $("#arFinishArea").disabled = !roofDone();
    };
    const closeCurrent = () => {
      if (!current || current.points.length < 3) return false;
      current.closed = true;
      drawShape(current, false);
      closed.push(current);
      current = null;
      return true;
    };
    $("#arClose").onclick = () => {
      const wasRoof = current?.kind === "roof";
      if (!closeCurrent()) return;
      msg.textContent = wasRoof
        ? "Roof captured. Add obstructions (water tank, stair room) or press Finish."
        : "Obstruction added. Add another or press Finish.";
      ui();
    };
    $("#arObs").onclick = () => {
      current = newShape("obstruction");
      msg.textContent = "Tap the corners of the obstruction on the floor, then Close shape.";
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
      if (current && current.points.length >= 3) closeCurrent();
      if (!closed.length) return;
      const shapes = closed.map((s) => s.points.map((p) => flat(p.pos)));
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
    if (!lastHit || performance.now() - lastHitT > HOLD_MS) {
      diag(`place: no surface (hits ${stats.hitFrames}/${stats.frames} frames)`);
      msg.textContent = "No floor under the crosshair yet. Move the phone slowly over a textured, well-lit floor.";
      return;
    }
    addPoint(current);
    stats.placed++;
    diag(`placed point ${current.points.length} (${current.kind})`);
    navigator.vibrate?.(30);
    const n = current.points.length;
    if (mode === "length") {
      msg.textContent = n === 1 ? "Walk along the wall to its other corner and place a point." : "Place more points, or press Save length.";
    } else {
      msg.textContent = n < 3 ? "Walk to the next corner, aim the crosshair at it, Place point."
        : "Next corner, or Close shape after the last one.";
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
    }
    const results = frame.getHitTestResults(hitSource);
    if (results.length) stats.rawResults++;
    const pose = results.length ? results[0].getPose(ref) : null;
    if (pose) {
      stats.hitFrames++;
      hit = results[0];
      lastHit = hit;
      lastHitT = now;
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticlePos.setFromMatrixPosition(reticle.matrix);
      recent.push({ t: now, p: reticlePos.clone() });
      if (msg.textContent.startsWith("Move")) msg.textContent = "Aim the crosshair at a corner on the ground, hold steady, press Place point.";
    } else {
      hit = null;
      reticle.visible = false;
    }
    while (recent.length && now - recent[0].t > STEADY_MS + HOLD_MS) recent.shift();
    const usable = now - lastHitT <= HOLD_MS;
    track.textContent = hit ? "● Floor found: ready to place"
      : usable ? "● Floor found (hold steady)" : "○ Searching for the floor… move slowly";
    track.classList.toggle("ok", usable);
    $("#arPlace").disabled = !current;  // never disabled by tracking flicker; placePoint explains if no surface
    if (now - lastReport > (now - t0 < 30000 ? 3000 : 10000)) {
      lastReport = now;
      diag(`frames ${stats.frames}, tracked ${stats.tracked} (emulated ${stats.emulated}), hit results ${stats.rawResults}, `
        + `floor hits ${stats.hitFrames}, presses ${stats.presses}, taps ${stats.selects}, placed ${stats.placed}`);
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
    renderer.dispose();
    renderer.domElement.remove();
    overlay.hidden = true;
  });
}

// ---------- wire up ----------

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
      if (note) note.textContent = REASONS[a] + (mode === "area" ? " You can type the roof size below instead." : " Or type a tape-measured length in the calibration box.");
    }
  }
}

init();
