// AR wall measurement (WebXR immersive-ar + hit-test), used to calibrate the image scale.
// Works in Chrome on ARCore Android phones over HTTPS. Elsewhere the button explains why and the
// user types a length measured another way (tape, iPhone Measure app).
//
// Flow: tap the ground at the wall corners (several taps for long walls = segments), "Save length",
// repeat ~3 times, "Use median" -> the median fills the calibration box and starts calibration.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const $ = (s) => document.querySelector(s);
const SPREAD_WARN = 0.03;  // warn when repeats differ by more than 3% of the median

// ---------- pure helpers (also used by tests) ----------

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
  insecure: "AR measuring needs the secure https:// address of this site.",
  unsupported: "AR measuring needs Chrome on an Android phone with ARCore. Otherwise measure the wall with a tape "
    + "(or the iPhone Measure app) and type the length in the calibration box.",
};

// ---------- AR session ----------

let session = null;

async function startAR() {
  const overlay = $("#arOverlay");
  overlay.hidden = false;  // dom-overlay root must be displayed when the session starts
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "dom-overlay"],
      optionalFeatures: ["anchors"],
      domOverlay: { root: overlay },
    });
  } catch (e) {
    overlay.hidden = true;
    window.SolarScopeStatus?.(`Could not start AR: ${e.message}`, "error");
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const dotGeo = new THREE.SphereGeometry(0.03, 16, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xf59e0b });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  scene.add(line);

  const points = [];   // {pos: Vector3, anchor?: XRAnchor, mesh}
  const lengths = [];  // saved measurements (m)
  let hit = null;
  const reticlePos = new THREE.Vector3();

  const viewerSpace = await session.requestReferenceSpace("viewer");
  const hitSource = await session.requestHitTestSource({ space: viewerSpace });

  const msg = $("#arMsg"), live = $("#arLive"), list = $("#arList");
  msg.textContent = "Move the phone slowly over the ground until the white ring appears.";

  function redrawLine() {
    const pts = points.map((p) => p.pos);
    if (reticle.visible && points.length) pts.push(reticlePos.clone());
    line.geometry.setFromPoints(pts);
  }

  function updateUI() {
    const done = polylineLength(points.map((p) => p.pos));
    const toReticle = reticle.visible && points.length ? reticlePos.distanceTo(points[points.length - 1].pos) : 0;
    live.textContent = points.length ? `${(done + toReticle).toFixed(2)} m` : "–";
    const sum = summarize(lengths);
    list.innerHTML = lengths.length
      ? `Saved: ${lengths.map((v) => v.toFixed(2)).join(", ")} m<br>`
        + `Median <b>${sum.median.toFixed(2)} m</b> ± ${sum.halfRange.toFixed(2)}`
        + (sum.n > 1 && sum.relSpread > SPREAD_WARN ? ' <span class="ar-warn">repeats disagree, measure again</span>' : "")
      : "Measure the same wall 3 times for a reliable median.";
    $("#arDone").disabled = !lengths.length;
    $("#arFinish").disabled = points.length < 2;
    $("#arUndo").disabled = !points.length;
  }

  // Taps on the camera view add a point at the ring; taps on overlay buttons must not.
  for (const el of overlay.querySelectorAll(".ar-panel")) {
    el.addEventListener("beforexrselect", (e) => e.preventDefault());
  }
  session.addEventListener("select", () => {
    if (!hit) return;
    const p = { pos: reticlePos.clone(), mesh: new THREE.Mesh(dotGeo, dotMat) };
    p.mesh.position.copy(p.pos);
    scene.add(p.mesh);
    points.push(p);
    // Pin the corner in the world so tracking corrections do not drift it.
    hit.createAnchor?.()?.then((a) => { p.anchor = a; }).catch(() => {});
    msg.textContent = points.length === 1
      ? "Walk along the wall and tap its other corner (tap more points for long walls)."
      : "Tap more points, or press Save length.";
    updateUI();
  });

  const onUndo = () => {
    const p = points.pop();
    if (p) { scene.remove(p.mesh); p.anchor?.delete?.(); }
    updateUI();
  };
  const onFinish = () => {
    if (points.length < 2) return;
    lengths.push(polylineLength(points.map((p) => p.pos)));
    while (points.length) onUndo();
    msg.textContent = lengths.length < 3 ? "Saved. Measure the same wall again from the first corner." : "Saved. Press Use median.";
    updateUI();
  };
  const end = (result) => {
    session.end().catch(() => {});
    if (result) window.SolarScopeApplyARLength?.(result);
  };
  const onDone = () => { const s = summarize(lengths); if (s) end({ ...s, values: [...lengths] }); };
  const onExit = () => end(null);

  $("#arUndo").onclick = onUndo;
  $("#arFinish").onclick = onFinish;
  $("#arDone").onclick = onDone;
  $("#arExit").onclick = onExit;
  updateUI();

  renderer.setAnimationLoop((_, frame) => {
    if (!frame) return;
    const ref = renderer.xr.getReferenceSpace();
    const results = frame.getHitTestResults(hitSource);
    if (results.length) {
      hit = results[0];
      const pose = hit.getPose(ref);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticlePos.setFromMatrixPosition(reticle.matrix);
      if (!points.length && msg.textContent.startsWith("Move")) msg.textContent = "Point the ring at a wall corner on the ground and tap.";
    } else {
      hit = null;
      reticle.visible = false;
    }
    for (const p of points) {
      if (!p.anchor) continue;
      const ap = frame.getPose(p.anchor.anchorSpace, ref);
      if (ap) { p.pos.set(ap.transform.position.x, ap.transform.position.y, ap.transform.position.z); p.mesh.position.copy(p.pos); }
    }
    redrawLine();
    updateUI();
    renderer.render(scene, camera);
  });

  session.addEventListener("end", () => {
    renderer.setAnimationLoop(null);
    hitSource.cancel?.();
    renderer.dispose();
    renderer.domElement.remove();
    overlay.hidden = true;
    session = null;
  });
}

// ---------- wire up ----------

async function init() {
  const btn = $("#arBtn"), note = $("#arNote");
  if (!btn) return;
  const a = await availability();
  if (a === "ok") {
    btn.disabled = false;
    note.textContent = "Stand outside the house, tap where the wall meets the ground at both corners.";
    btn.addEventListener("click", startAR);
  } else {
    btn.disabled = true;
    note.textContent = REASONS[a];
  }
}

init();
