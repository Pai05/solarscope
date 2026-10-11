"use strict";
// Image page. Needs common.js (helpers, settings, report card) loaded first.

// Working image is at most MAX_SIDE px; mask, brush, calibration and report all use its pixels.
const MAX_SIDE = 1024;
const OVERLAY_ALPHA = 110;
const CLASS_RGB = { 1: [34, 197, 94], 2: [239, 68, 68] };
const ZOOM_MIN = 1, ZOOM_MAX = 12, ZOOM_STEP = 1.5;  // zoom is relative to "fit to view"

const imgCv = $("#img");
const ovCv = $("#overlay");
const ictx = imgCv.getContext("2d");
const octx = ovCv.getContext("2d");

const state = {
  w: 0, h: 0,
  resize: 1,          // working px / original px
  gsd: 0.1,           // metres per WORKING pixel
  mask: null,         // Uint8Array w*h, 0 bg / 1 roof / 2 obstruction
  overlay: null,      // ImageData
  imgBlob: null,
  tool: "1",
  brush: 10,
  undo: [],
  roofPoint: null,
  roofBox: null,      // [x0, y0, x1, y1] area to analyse
  boxStart: null,
  calib: null,        // {a, b} while calibrating
  calibrating: false,
  painting: false,
  last: null,
  panels: [],
  quads: [],          // panels mapped onto the photo: [{pts: [[x, y] x4], small}] (photo + typed roof size)
  obs: [],            // painted obstructions: [{x, y, n, shape: "rect"|"sides", vals: {...}, drawn}] (photo px)
  defaults: null,
  zoom: 1,            // 1 = whole image fits the view
  baseScale: 1,       // CSS px per image px at zoom 1
  panMode: false,
  panning: null,      // {x, y, sl, st} while dragging the view
};

// ---------- image loading ----------

async function loadImage(blob, meta = {}) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  imgCv.width = ovCv.width = w;
  imgCv.height = ovCv.height = h;
  ictx.imageSmoothingQuality = "high";
  ictx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  Object.assign(state, {
    w, h, resize: k, mask: new Uint8Array(w * h), overlay: octx.createImageData(w, h),
    undo: [], roofPoint: null, roofBox: null, panels: [], calib: null, calibrating: false, zoom: 1, obs: [],
  });
  state.imgBlob = await new Promise((res) => imgCv.toBlob(res, "image/png"));

  if (meta.gsd) $("#gsd").value = meta.gsd;
  setGsdFromInput();
  if (meta.lat !== undefined) { $("#lat").value = meta.lat; $("#lon").value = meta.lon; }

  $("#placeholder").hidden = true;
  markStep("capture", true);
  markStep("correct", false);
  $("#canvasBox").hidden = false;
  $("#zoombar").hidden = false;
  $("#report").hidden = true;
  reportStale();
  for (const id of ["#detectBtn", "#reportBtn", "#calibBtn"]) $(id).disabled = false;
  updateUndo();
  fitCanvas();
  render();
  setStatus(`Image loaded (${w}×${h} px). Set the scale, then detect the roof — or paint it by hand.`);
}

function fitCanvas() {
  if (!state.w) return;
  const stage = $("#stage");
  const maxW = stage.parentElement.clientWidth - 18;  // independent of the stage's own scrollbars
  const maxH = Math.max(320, window.innerHeight * 0.72);
  state.baseScale = Math.min(maxW / state.w, maxH / state.h);
  stage.style.height = `${Math.floor(state.h * state.baseScale) + 18}px`;
  applyZoom();
}
window.addEventListener("resize", fitCanvas);

// ---------- zoom & pan ----------

function applyZoom() {
  const s = state.baseScale * state.zoom;
  for (const c of [imgCv, ovCv]) {
    c.style.width = `${Math.round(state.w * s)}px`;
    c.style.height = `${Math.round(state.h * s)}px`;
  }
  $("#zoomVal").textContent = `${Math.round(state.zoom * 100)}%`;
  $("#zoomOut").disabled = state.zoom <= ZOOM_MIN;
  $("#zoomIn").disabled = state.zoom >= ZOOM_MAX;
}

// Zoom keeping the image point under (clientX, clientY) fixed; defaults to the view centre.
function zoomTo(z, clientX, clientY) {
  if (!state.w) return;
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (Math.abs(z - state.zoom) < 1e-3) return;
  const stage = $("#stage");
  if (clientX === undefined) {
    const sr = stage.getBoundingClientRect();
    clientX = sr.left + sr.width / 2;
    clientY = sr.top + sr.height / 2;
  }
  const r = ovCv.getBoundingClientRect();
  const fx = (clientX - r.left) / r.width, fy = (clientY - r.top) / r.height;
  state.zoom = z;
  applyZoom();
  const r2 = ovCv.getBoundingClientRect();
  const k = pageZoom(stage);  // scroll offsets are CSS px, the rects above are screen px
  stage.scrollLeft += (r2.left + fx * r2.width - clientX) / k;
  stage.scrollTop += (r2.top + fy * r2.height - clientY) / k;
}

let spaceDown = false;
const updateCursor = () => { ovCv.style.cursor = state.panMode || spaceDown ? "grab" : "crosshair"; };
const typing = (e) => ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);

$("#zoomIn").addEventListener("click", () => zoomTo(state.zoom * ZOOM_STEP));
$("#zoomOut").addEventListener("click", () => zoomTo(state.zoom / ZOOM_STEP));
$("#zoomFit").addEventListener("click", () => zoomTo(1));
$("#panBtn").addEventListener("click", () => {
  state.panMode = !state.panMode;
  $("#panBtn").classList.toggle("active", state.panMode);
  updateCursor();
});
// Over the image, the wheel / trackpad pinch (Ctrl+wheel) / Ctrl +/-/0 zoom the image, never the page.
const stageWrap = $(".stage-wrap");
let overImage = false;
stageWrap.addEventListener("pointerenter", () => { overImage = true; });
stageWrap.addEventListener("pointerleave", () => { overImage = false; });
stageWrap.addEventListener("wheel", (e) => {
  if (!state.w) return;
  const onStage = e.target.closest("#stage");
  if (!onStage && !(e.ctrlKey || e.metaKey)) return;  // plain wheel over the toolbar/legend scrolls the page
  e.preventDefault();
  zoomTo(state.zoom * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), e.clientX, e.clientY);
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (!state.w || typing(e) || e.altKey) return;
  if (e.ctrlKey || e.metaKey) {
    if (!overImage) return;  // elsewhere, browser page zoom keeps working
    const z = { "+": ZOOM_STEP, "=": ZOOM_STEP, "-": 1 / ZOOM_STEP, "_": 1 / ZOOM_STEP }[e.key];
    if (z) { e.preventDefault(); zoomTo(state.zoom * z); }
    else if (e.key === "0") { e.preventDefault(); zoomTo(1); }
    return;
  }
  if (e.code === "Space" && !overImage) return;  // Space only pans while the mouse is over the image
  if (e.code === "Space") { spaceDown = true; updateCursor(); e.preventDefault(); }
  else if (e.key === "+" || e.key === "=") zoomTo(state.zoom * ZOOM_STEP);
  else if (e.key === "-" || e.key === "_") zoomTo(state.zoom / ZOOM_STEP);
  else if (e.key === "0") zoomTo(1);
}, true);  // capture phase: runs before anything else can let the browser zoom the page
window.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; updateCursor(); } });

// Two-finger pinch on touch screens: zoom around the fingers' midpoint and pan with them.
const touches = new Map();
let pinch = null;
function pinchState() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

// ---------- scale ----------

function setGsdFromInput() {
  const v = num("#gsd");
  if (v && v > 0) state.gsd = v / state.resize;
  showGsd();
}

function showGsd() {
  const brushM = state.brush * state.gsd;
  $("#gsdInfo").textContent = state.w
    ? `Working image: ${state.gsd.toFixed(4)} m/px · ${(state.w * state.gsd).toFixed(1)} × ${(state.h * state.gsd).toFixed(1)} m`
    : "";
  // Metres only mean something when the image scale is used; with a typed roof size the photo has no fixed scale.
  $("#brushVal").textContent = useGsd() ? `${state.brush} px ≈ ${brushM.toFixed(2)} m` : `${state.brush} px`;
}

$("#gsd").addEventListener("input", () => { setGsdFromInput(); markStale(); });
// Roof size (photos) vs image scale (drone / satellite images with a known metres-per-pixel).
function useGsd() { return $("#useGsd").checked; }
function chooseGsdMode(on) {
  $("#useGsd").checked = on;
  if (on) $("#gsdMode").open = true;
  showGsd();
  markStale();
}
$("#useGsd").addEventListener("change", (e) => chooseGsdMode(e.target.checked));
const SIDE_IDS = ["#sideTop", "#sideRight", "#sideBottom", "#sideLeft"];
function roofShape() { return document.querySelector('input[name="roofShape"]:checked').value; }
for (const id of ["#roofLen", "#roofWid", ...SIDE_IDS, "#sideDiag"]) {
  $(id).addEventListener("input", () => { if (num(id) > 0) $("#useGsd").checked = false; showGsd(); updateSidePreview(); markStale(); });
}
for (const r of document.querySelectorAll('input[name="roofShape"]')) {
  r.addEventListener("change", () => {
    $("#rectInputs").hidden = roofShape() !== "rect";
    $("#sideInputs").hidden = roofShape() !== "sides";
    updateSidePreview();
    markStale();
  });
}

// Same shape as the server's geometry.quad_from_sides: corners (top-left, top-right, bottom-right, bottom-left,
// metres, y down) of the 4 sides; without a diagonal the most regular shape (corners on a circle). Null if the
// sides cannot close.
function quadFromSides(a, b, c, d, e) {
  if (!(e > 0)) e = Math.sqrt(((a * c + b * d) * (a * d + b * c)) / (a * b + c * d));
  const ok = (x, y, z) => x + y > z * 1.0001 && x + z > y * 1.0001 && y + z > x * 1.0001;
  if (!ok(a, b, e) || !ok(c, d, e)) return null;
  const x = (e * e - b * b + a * a) / (2 * a);
  const p2 = [x, Math.sqrt(Math.max(e * e - x * x, 0))];
  const u = [p2[0] / e, p2[1] / e], n = [-u[1], u[0]];
  const t = (e * e - c * c + d * d) / (2 * e), h = Math.sqrt(Math.max(d * d - t * t, 0));
  let p3 = [t * u[0] + h * n[0], t * u[1] + h * n[1]];
  const side = (p) => p2[0] * p[1] - p2[1] * p[0];
  if (side([a, 0]) * side(p3) > 0) p3 = [t * u[0] - h * n[0], t * u[1] - h * n[1]];
  return [[0, 0], [a, 0], p2, p3];
}

// Live drawing of the typed 4 sides, its area, and a check that opposite sides are plausible.
function updateSidePreview() {
  const box = $("#sidePreview");
  const v = SIDE_IDS.map((id) => num(id));
  if (roofShape() !== "sides" || !v.every((x) => x > 0)) { box.hidden = true; return; }
  box.hidden = false;
  const svg = $("#sideSvg");
  const q = quadFromSides(...v, num("#sideDiag"));
  const warn = $("#sideWarn");
  if (!q) {
    svg.innerHTML = "";
    $("#sideArea").textContent = "";
    warn.hidden = false;
    warn.textContent = "These sides (and diagonal) cannot form a closed roof shape. Check the measurements.";
    return;
  }
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const k = Math.min(200 / (Math.max(...xs) - minX), 110 / (Math.max(...ys) - minY));
  const P = q.map(([x, y]) => [30 + (x - minX) * k, 28 + (y - minY) * k]);
  const names = ["Top", "Right", "Bottom", "Left"];
  const cx = P.reduce((s, p) => s + p[0], 0) / 4, cy = P.reduce((s, p) => s + p[1], 0) / 4;
  const labels = P.map(([x1, y1], i) => {
    const [x2, y2] = P[(i + 1) % 4];
    let mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = Math.hypot(mx - cx, my - cy) || 1;
    mx += ((mx - cx) / d) * 14;
    my += ((my - cy) / d) * 12;
    return `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${names[i]} ${fmt(v[i], 1)} m</text>`;
  }).join("");
  svg.innerHTML = `<polygon points="${P.map((p) => p.map((c) => c.toFixed(1)).join(",")).join(" ")}" fill="rgba(34,197,94,0.35)" stroke="#16a34a" stroke-width="2"/>`
    + `<g font-size="11" font-weight="700" fill="currentColor">${labels}</g>`;
  const area = Math.abs(q.reduce((s, [x1, y1], i) => { const [x2, y2] = q[(i + 1) % 4]; return s + x1 * y2 - x2 * y1; }, 0)) / 2;
  $("#sideArea").textContent = `Area about ${fmt(area, 1)} m²` + (num("#sideDiag") > 0 ? "" : " (most regular shape for these sides)");
  // Opposite sides very different: usually a side measured to the photo's edge instead of the roof's edge.
  const msgs = [];
  for (const [i, j] of [[0, 2], [1, 3]]) {
    const big = Math.max(v[i], v[j]), small = Math.min(v[i], v[j]);
    if (small < big * 0.7) msgs.push(`${names[i]} ${fmt(v[i], 1)} m vs ${names[j].toLowerCase()} ${fmt(v[j], 1)} m`);
  }
  warn.hidden = !msgs.length;
  warn.textContent = msgs.length
    ? `${msgs.join(" and ")}: the roof narrows a lot, so panels only fit in its wide part. If that side runs out of the `
      + "photo, measure the real roof edge (not the photo's edge) or choose Rectangle."
    : "";
}

// The typed roof size: {body: request fields, dims: {L, W} for advice, text: for messages}, or an error message.
function typedRoof() {
  if (roofShape() === "sides") {
    const sides = SIDE_IDS.map((id) => num(id));
    if (!sides.every((v) => v > 0)) {
      return { error: "Type all 4 sides of your roof in step 2 (Roof size): top, right, bottom and left as seen in the photo.", focus: SIDE_IDS[sides.findIndex((v) => !(v > 0))] };
    }
    const diag = num("#sideDiag");
    return {
      body: { roof_sides_m: sides, roof_diagonal_m: diag > 0 ? diag : null },
      dims: { L: Math.max(sides[0], sides[2]), W: Math.max(sides[1], sides[3]) },
      text: `${sides.map((v) => fmt(v, 1)).join(" / ")} m `,
    };
  }
  const L = num("#roofLen"), W = num("#roofWid");
  if (!(L > 0 && W > 0)) {
    return { error: "Type your roof's real length and width in step 2 (Roof size). A photo alone cannot show how big "
      + "the roof is. For a drone or satellite image with a known scale, open 'Drone or satellite image'.", focus: "#roofLen" };
  }
  return { body: { roof_length_m: L, roof_width_m: W }, dims: { L: Math.max(L, W), W: Math.min(L, W) },
    text: `${fmt(Math.max(L, W), 1)} × ${fmt(Math.min(L, W), 1)} m ` };
}
$("#budget")?.addEventListener("input", markStale);
$("#budgetBasis")?.addEventListener("change", markStale);

$("#calibBtn").addEventListener("click", () => {
  state.calibrating = true;
  state.calib = null;
  $("#calibBox").hidden = true;
  setStatus("Calibrate: drag a line across something of known length (e.g. a water tank, a door, a car).");
});

// Called by ar.js with {median, halfRange, relSpread, n, values} after an AR wall measurement.
window.SolarScopeStatus = setStatus;
window.SolarScopeApplyARLength = (r) => {
  $("#calibLen").value = r.median.toFixed(2);
  const spread = `${r.median.toFixed(2)} m ± ${r.halfRange.toFixed(2)} (median of ${r.n})`;
  if (!state.w) {
    setStatus(`AR wall length ${spread}. Load the roof image, press Calibrate and drag along the same wall.`);
    return;
  }
  $("#calibBtn").click();
  setStatus(`AR wall length ${spread}. Now drag a line along the same wall on the image, then press Apply.`);
};

$("#calibApply").addEventListener("click", () => {
  const len = num("#calibLen");
  if (!state.calib || !len) return;
  const { a, b } = state.calib;
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (px < 3) { setStatus("Line too short; draw it again.", "error"); return; }
  state.gsd = len / px;
  $("#gsd").value = (state.gsd * state.resize).toFixed(4);
  state.calib = null;
  $("#calibBox").hidden = true;
  chooseGsdMode(true);  // a calibrated scale means: use the image scale, not a typed roof size
  render();
  setStatus(`Scale set: ${px.toFixed(0)} px = ${len} m → ${state.gsd.toFixed(4)} m/px.`);
});

// ---------- drawing ----------

function render() {
  if (!state.w) return;
  octx.clearRect(0, 0, state.w, state.h);
  if ($("#showOverlay").checked) {
    const d = state.overlay.data;
    const m = state.mask;
    for (let i = 0, j = 0; i < m.length; i++, j += 4) {
      const c = CLASS_RGB[m[i]];
      if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = OVERLAY_ALPHA; }
      else d[j + 3] = 0;
    }
    octx.putImageData(state.overlay, 0, 0);
  }

  const lw = Math.max(1, state.w / 500);
  if (state.panels.length) {
    octx.fillStyle = "rgba(37, 99, 235, 0.6)";
    octx.strokeStyle = "rgba(219, 234, 254, 0.95)";
    octx.lineWidth = lw;
    for (const [x, y, w, h, small] of state.panels) {
      octx.fillStyle = small ? "rgba(13, 148, 136, 0.7)" : "rgba(37, 99, 235, 0.6)";  // gap-fillers teal
      octx.fillRect(x, y, w, h);
      octx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
    }
  }
  // Panels laid out on the to-scale plan, drawn back onto the photo (they follow the roof's angle).
  if (state.quads.length) {
    octx.lineWidth = lw;
    octx.strokeStyle = "rgba(219, 234, 254, 0.95)";
    for (const { pts, small } of state.quads) {
      octx.beginPath();
      pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      octx.closePath();
      octx.fillStyle = small ? "rgba(13, 148, 136, 0.7)" : "rgba(37, 99, 235, 0.65)";
      octx.fill();
      octx.stroke();
    }
  }
  // The roof corners used for the size, with each side's length (Top / Right / ... for a 4-sided roof).
  if (state.photoRoof && state.quads) {
    const { corners, sides, named } = state.photoRoof;
    octx.setLineDash([lw * 5, lw * 3]);
    octx.strokeStyle = "#fde047";
    octx.lineWidth = lw * 2;
    octx.beginPath();
    corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.closePath();
    octx.stroke();
    octx.setLineDash([]);
    const cx = corners.reduce((a, q) => a + q[0], 0) / 4, cy = corners.reduce((a, q) => a + q[1], 0) / 4;
    const names = ["Top", "Right", "Bottom", "Left"];
    octx.font = `700 ${Math.round(lw * 11)}px system-ui, sans-serif`;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    corners.forEach(([x1, y1], i) => {
      const [x2, y2] = corners[(i + 1) % 4];
      const mx = (x1 + x2) / 2 + (cx - (x1 + x2) / 2) * 0.12, my = (y1 + y2) / 2 + (cy - (y1 + y2) / 2) * 0.12;
      const text = `${named ? `${names[i]} ` : ""}${fmt(sides[i], 1)} m`;
      const w = octx.measureText(text).width + lw * 10, h = lw * 18;
      octx.fillStyle = "rgba(10, 22, 51, 0.85)";
      octx.fillRect(mx - w / 2, my - h / 2, w, h);
      octx.fillStyle = "#fde047";
      octx.fillText(text, mx, my);
    });
  }
  if (state.obs.length) {
    const r = Math.max(lw * 9, Math.max(state.w, state.h) / 45);  // readable on a phone
    octx.font = `800 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    state.obs.forEach((o, k) => {
      octx.beginPath();
      octx.arc(o.x, o.y, r, 0, Math.PI * 2);
      octx.fillStyle = "#7f1d1d";
      octx.fill();
      octx.lineWidth = lw * 1.5;
      octx.strokeStyle = "#ffffff";
      octx.stroke();
      octx.fillStyle = "#ffffff";
      octx.fillText(String(k + 1), o.x, o.y + 0.5);
    });
  }
  if (state.roofBox) {
    const [x0, y0, x1, y1] = state.roofBox;
    octx.setLineDash([lw * 6, lw * 4]);
    octx.strokeStyle = "#2563eb";
    octx.lineWidth = lw * 2.5;
    octx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    octx.setLineDash([]);
  }
  if (state.roofPoint) {
    const [x, y] = state.roofPoint;
    octx.beginPath();
    octx.arc(x, y, Math.max(4, state.w / 80), 0, Math.PI * 2);
    octx.fillStyle = "#2563eb";
    octx.strokeStyle = "#fff";
    octx.lineWidth = lw * 2;
    octx.fill();
    octx.stroke();
  }
  if (state.calib) {
    const { a, b } = state.calib;
    octx.beginPath();
    octx.moveTo(a.x, a.y);
    octx.lineTo(b.x, b.y);
    octx.strokeStyle = "#facc15";
    octx.lineWidth = lw * 2.5;
    octx.stroke();
  }
}
$("#showOverlay").addEventListener("change", render);

function stamp(cx, cy) {
  const r = state.brush / 2, r2 = r * r, v = Number(state.tool);
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(state.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(state.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) state.mask[y * state.w + x] = v;
    }
  }
}

function strokeTo(p) {
  const a = state.last || p;
  const dist = Math.hypot(p.x - a.x, p.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, state.brush / 4)));
  for (let i = 1; i <= steps; i++) stamp(a.x + ((p.x - a.x) * i) / steps, a.y + ((p.y - a.y) * i) / steps);
  state.last = p;
}

function pos(e) {
  const r = ovCv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * state.w) / r.width, y: ((e.clientY - r.top) * state.h) / r.height };
}

function pushUndo() {
  markStep("correct", true);
  state.undo.push(state.mask.slice());
  if (state.undo.length > 20) state.undo.shift();
  updateUndo();
}
function updateUndo() { $("#undoBtn").disabled = state.undo.length === 0; }

function markStale() {
  if (state.panels.length || state.quads.length) {
    state.panels = [];
    state.quads = [];
    state.photoRoof = null;
    $("#photoPlanBox").hidden = true;
    setStatus("Mask or scale changed — compute the report again.");
    reportStale();
  }
}

let raf = 0;
const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

ovCv.addEventListener("pointerdown", (e) => {
  if (!state.w) return;
  e.preventDefault();
  ovCv.setPointerCapture(e.pointerId);
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      // Second finger: this is a pinch, so undo whatever the first finger started.
      if (state.painting && !state.calibrating && !state.boxStart && state.undo.length) {
        state.mask = state.undo.pop();
        updateUndo();
      }
      state.painting = false;
      state.boxStart = null;
      state.last = null;
      pinch = { ...pinchState(), z0: state.zoom };
      render();
      return;
    }
    if (touches.size > 2) return;
  }
  if (state.panMode || spaceDown || e.button === 1) {
    const stage = $("#stage");
    state.panning = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    ovCv.style.cursor = "grabbing";
    return;
  }
  const p = pos(e);
  if (state.calibrating) {
    state.calib = { a: p, b: p };
    state.painting = true;
    return;
  }
  if (state.tool === "point") {
    state.boxStart = p;
    state.roofBox = null;
    state.roofPoint = null;
    state.painting = true;
    return;
  }
  pushUndo();
  state.painting = true;
  state.last = null;
  strokeTo(p);
  markStale();
  scheduleRender();
});

ovCv.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const now = pinchState();
      zoomTo(pinch.z0 * now.d / pinch.d, now.mx, now.my);
      const stage = $("#stage");
      stage.scrollLeft -= now.mx - pinch.mx;
      stage.scrollTop -= now.my - pinch.my;
      pinch.mx = now.mx;
      pinch.my = now.my;
      return;
    }
  }
  if (state.panning) {
    const stage = $("#stage");
    const k = pageZoom(stage);
    stage.scrollLeft = state.panning.sl - (e.clientX - state.panning.x) / k;
    stage.scrollTop = state.panning.st - (e.clientY - state.panning.y) / k;
    return;
  }
  if (!state.painting) return;
  const p = pos(e);
  if (state.calibrating) state.calib.b = p;
  else if (state.boxStart) state.roofBox = [state.boxStart.x, state.boxStart.y, p.x, p.y].map(Math.round);
  else strokeTo(p);
  scheduleRender();
});

function endStroke(e) {
  if (e && e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  }
  if (state.panning) {
    state.panning = null;
    updateCursor();
    return;
  }
  if (!state.painting) return;
  state.painting = false;
  state.last = null;
  if (state.boxStart) {
    const a = state.boxStart;
    state.boxStart = null;
    markStale();
    const b = state.roofBox;
    if (!b || Math.abs(b[2] - b[0]) < 8 || Math.abs(b[3] - b[1]) < 8) {
      state.roofBox = null;
      state.roofPoint = [Math.round(a.x), Math.round(a.y)];
      setStatus("Roof picked: only the connected roof under the dot is analysed. Roofs merged with neighbours? Drag a box instead.");
    } else {
      setStatus("Area selected: only roof inside the box is analysed.");
    }
    render();
  }
  if (state.calibrating) {
    state.calibrating = false;
    $("#calibBox").hidden = false;
    $("#calibLen").focus();
    setStatus("Enter the real length of the yellow line and press Apply.");
  }
  refreshObstructions();  // a brush stroke may have added, joined or erased obstructions
}
ovCv.addEventListener("pointerup", endStroke);
ovCv.addEventListener("pointercancel", endStroke);

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    state.tool = b.dataset.tool;
    document.querySelectorAll(".tool").forEach((t) => {
      t.classList.toggle("active", t === b);
      t.setAttribute("aria-pressed", String(t === b));
    });
  });
}
$("#brush").addEventListener("input", (e) => { state.brush = Number(e.target.value); showGsd(); });
$("#undoBtn").addEventListener("click", () => {
  const prev = state.undo.pop();
  if (prev) { state.mask = prev; refreshObstructions(); markStale(); render(); }
  updateUndo();
});
$("#clearPointBtn").addEventListener("click", () => {
  state.roofPoint = null;
  state.roofBox = null;
  markStale();
  render();
  setStatus("Analysing every roof in the image.");
});

// ---------- API calls ----------

$("#detectBtn").addEventListener("click", (e) => busy(e.currentTarget, "Detecting roof and obstructions…", async () => {
  const fd = new FormData();
  fd.append("file", state.imgBlob, "roof.png");
  fd.append("gsd_m", String(state.gsd));
  const r = await fetch("/predict", { method: "POST", body: fd });
  if (!r.ok) throw new Error(await apiError(r));
  const j = await r.json();
  const m = bytesFromB64(j.mask_b64);
  if (j.width !== state.w || j.height !== state.h || m.length !== state.w * state.h) throw new Error("Mask size mismatch.");
  pushUndo();
  state.mask = m;
  refreshObstructions();
  markStale();
  render();
  markStep("correct", true);
  setStatus("Done. Fix mistakes with the brush, pick your roof, then compute the report.");
}));

$("#file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { await loadImage(f); } catch (err) { setStatus(`Could not open image: ${err.message}`, "error"); }
  e.target.value = "";
});

$("#reportBtn").addEventListener("click", (e) => busy(e.currentTarget, "Laying out panels and computing the report…", async () => {
  if (!state.mask.some((v) => v === 1)) throw new Error("No roof in the mask yet. Detect it or paint it with the Roof brush.");
  const sized = !useGsd();
  const roof = sized ? typedRoof() : null;
  if (roof?.error) {
    $(roof.focus).focus();
    throw new Error(roof.error);
  }
  const rep = await postReport({
    width: state.w,
    height: state.h,
    mask_b64: b64FromBytes(state.mask),
    gsd_m: state.gsd,
    roof_point: state.roofPoint,
    roof_box: state.roofBox,
    ...(sized ? {
      ...roof.body,
      obstruction_inputs: obstructionInputs(),
    } : {}),
    ...reportSettings(),
  });
  if (rep.plan) {
    // Panel boxes are in the to-scale plan; show them on the plan and, mapped back, on the photo.
    state.panels = [];
    state.quads = rep.plan.photo_panels.map((pts) => ({ pts, small: false }))
      .concat(rep.plan.photo_small_panels.map((pts) => ({ pts, small: true })));
    drawPhotoPlan(rep);
    state.photoRoof = { corners: rep.plan.photo_roof_corners, sides: rep.plan.roof_sides_m, named: roofShape() === "sides" };
    matchDrawnSizes(rep.plan.obstructions);
  } else {
    state.quads = [];
    state.photoRoof = null;
    state.panels = rep.panels.map((p) => [...p, false]).concat((rep.small_panels || []).map((p) => [...p, true]));
    $("#photoPlanBox").hidden = true;
  }
  render();
  showReport(rep, sized ? roof.dims : undefined);
  const nSmall = (rep.small_panels || []).length;
  const size = sized ? roof.text : "";
  setStatus(rep.panel_count
    ? `${rep.panel_count} panels (${fmt(rep.capacity_kw, 2)} kWp) fit on your ${size}roof`
      + (nSmall ? `: ${rep.panel_count - nSmall} standard + ${nSmall} small.` : ".")
      + (rep.budget?.limited ? ` Sized to your budget; the roof can hold ${rep.budget.roof_max.panel_count}.` : "")
      + (rep.plan?.roof_cut_off ? " ⚠ The marked roof reaches the edge of the photo, so part of the roof seems to be "
        + "out of the picture and its sides may not match what you typed. For an accurate plan use a photo that shows "
        + "all 4 roof corners." : "")
    : "No panel fits. Check the roof size, the setback or the roof mask.");
}));

// ---------- to-scale plan (photo + typed roof size) ----------

const planCv = $("#photoPlan");

function drawPhotoPlan(rep) {
  const p = rep.plan;
  $("#photoPlanBox").hidden = false;
  const cw = Math.max(240, planCv.parentElement.clientWidth - 24);
  const pad = 34;
  const k = Math.min((cw - 2 * pad) / p.width, 340 / p.height);  // CSS px per plan px
  const ch = Math.round(p.height * k + 2 * pad);
  const dpr = window.devicePixelRatio || 1;
  planCv.style.width = `${cw}px`;
  planCv.style.height = `${ch}px`;
  planCv.width = Math.round(cw * dpr);
  planCv.height = Math.round(ch * dpr);
  const g = planCv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const ox = (cw - p.width * k) / 2, oy = pad;
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  // Roof and obstructions from the plan mask.
  const mask = Uint8Array.from(atob(p.mask_b64), (c) => c.charCodeAt(0));
  const off = document.createElement("canvas");
  off.width = p.width;
  off.height = p.height;
  const offCtx = off.getContext("2d");
  const img = offCtx.createImageData(p.width, p.height);
  let minX = p.width, maxX = 0, minY = p.height, maxY = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % p.width, y = (i / p.width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    img.data.set(mask[i] === 2 ? [239, 68, 68, 220] : [34, 197, 94, 90], i * 4);
  }
  offCtx.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(off, ox, oy, p.width * k, p.height * k);

  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink").trim() || "#0a1633";
  const surface = css.getPropertyValue("--surface").trim() || "#fff";
  const panel = ([x, y, w, h], small) => {
    g.fillStyle = small ? "#0d9488" : "#2563eb";
    g.fillRect(X(x) + 0.5, Y(y) + 0.5, w * k - 1, h * k - 1);
    g.strokeStyle = "rgba(219,234,254,0.9)";
    g.lineWidth = 1;
    g.strokeRect(X(x) + 0.5, Y(y) + 0.5, w * k - 1, h * k - 1);
  };
  rep.panels.forEach((b) => panel(b, false));
  (rep.small_panels || []).forEach((b) => panel(b, true));
  if (rep.budget) {
    g.save();
    g.setLineDash([5, 4]);
    g.strokeStyle = ink;
    g.globalAlpha = 0.55;
    for (const [x, y, w, h] of rep.budget.spare_panels.concat(rep.budget.spare_small_panels)) {
      g.strokeRect(X(x) + 1.5, Y(y) + 1.5, w * k - 3, h * k - 3);
    }
    g.restore();
  }

  const pill = (text, x, y, bg = surface, fg = ink, border = "#16a34a") => {
    g.font = "700 12px system-ui, sans-serif";
    const w = g.measureText(text).width + 12, h = 20;
    g.beginPath();
    if (g.roundRect) g.roundRect(x - w / 2, y - h / 2, w, h, 6); else g.rect(x - w / 2, y - h / 2, w, h);
    g.fillStyle = bg;
    g.fill();
    g.strokeStyle = border;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, x, y + 0.5);
  };
  // Roof outline and the length of every side, just outside it; obstruction sizes on the obstructions.
  const c = p.roof_corners_m.map(([u, v]) => [X(u / p.gsd_m), Y(v / p.gsd_m)]);
  g.beginPath();
  c.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.strokeStyle = "#16a34a";
  g.lineWidth = 2;
  g.stroke();
  const cx = c.reduce((a, q) => a + q[0], 0) / 4, cy = c.reduce((a, q) => a + q[1], 0) / 4;
  c.forEach(([x1, y1], i) => {
    const [x2, y2] = c[(i + 1) % 4];
    let mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = Math.hypot(mx - cx, my - cy) || 1;
    mx += ((mx - cx) / d) * 16;
    my += ((my - cy) / d) * 16;
    pill(`${fmt(p.roof_sides_m[i], 2)} m`, Math.min(Math.max(mx, 30), cw - 30), Math.min(Math.max(my, 11), ch - 11));
  });
  for (const o of p.obstructions) {
    const t = o.sides_m ? `${o.sides_m.map((v) => fmt(v, 1)).join("/")} m` : `${fmt(o.length_m, 1)} × ${fmt(o.width_m, 1)} m`;
    pill(t, X(o.cx), Y(o.cy), "#7f1d1d", "#fff", "#fecaca");
  }
}

// ---------- obstructions painted on the photo, each with its real size ----------

// Separate painted obstructions (connected red areas) with their centre and size in photo px, top to bottom.
function scanObstructions() {
  const { w, h, mask } = state;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const minPx = Math.max(25, (w * h) / 4000);  // ignore brush specks
  const found = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 2 || seen[start]) continue;
    let head = 0, tail = 0, sx = 0, sy = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      sx += x;
      sy += y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && mask[j] === 2) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (tail >= minPx) found.push({ x: sx / tail + 0.5, y: sy / tail + 0.5, n: tail });
  }
  return found.sort((a, b) => (Math.abs(a.y - b.y) > h / 20 ? a.y - b.y : a.x - b.x));
}

// Rebuild the list after the drawing changed; typed sizes stay with the obstruction nearest to where they were.
function refreshObstructions() {
  if (!state.w) return;
  const old = state.obs;
  const reach = Math.max(state.w, state.h) * 0.08;
  state.obs = scanObstructions().map((o) => {
    let best = null, bestD = reach;
    for (const p of old) {
      const d = Math.hypot(p.x - o.x, p.y - o.y);
      if (d < bestD && !p.taken) { best = p; bestD = d; }
    }
    if (best) best.taken = true;
    return { ...o, shape: best?.shape || "rect", vals: best?.vals || {}, drawn: best?.drawn || null };
  });
  renderObstructionCards();
  render();
}

// Typed sizes for the report: each with a point on its obstruction, so the server finds it on the plan.
function obstructionInputs() {
  const out = [];
  for (const o of state.obs) {
    const v = o.vals;
    const size = o.shape === "sides" ? [v.top, v.right, v.bottom, v.left] : [v.len, v.wid];
    if (size.every((x) => x > 0)) out.push({ x: o.x, y: o.y, size });
  }
  return out.length ? out : null;
}

// After a report: the size each obstruction has on the to-scale plan ("drawn" or the typed size).
function matchDrawnSizes(list) {
  for (const o of state.obs) {
    let best = null, bestD = Infinity;
    for (const q of list) {
      const d = Math.hypot(q.photo_xy[0] - o.x, q.photo_xy[1] - o.y);
      if (d < bestD) { best = q; bestD = d; }
    }
    o.drawn = best && !best.typed ? `${fmt(best.length_m, 2)} × ${fmt(best.width_m, 2)} m` : null;
  }
  renderObstructionCards();
}

// One card per obstruction, like the roof: Rectangle (length x width) or 4 different sides.
function renderObstructionCards() {
  const ul = $("#obsSizeList");
  ul.replaceChildren();
  $("#obsSizes").hidden = !state.obs.length;
  state.obs.forEach((o, k) => {
    const li = document.createElement("li");
    li.className = "obs-card";
    const head = document.createElement("span");
    head.className = "obs-head";
    const badge = document.createElement("b");
    badge.className = "obs-badge";
    badge.textContent = String(k + 1);
    head.append(badge, ` Obstruction ${k + 1}` + (o.drawn ? ` · on the photo ≈ ${o.drawn}` : ""));
    li.append(head);

    const choice = document.createElement("div");
    choice.className = "shape-choice";
    for (const [value, text] of [["rect", "Rectangle"], ["sides", "4 different sides"]]) {
      const lab = document.createElement("label");
      lab.className = "inline";
      const r = document.createElement("input");
      Object.assign(r, { type: "radio", name: `obsShape${k}`, value, checked: o.shape === value });
      r.addEventListener("change", () => { o.shape = value; renderObstructionCards(); markStale(); });
      lab.append(r, ` ${text}`);
      choice.append(lab);
    }
    li.append(choice);

    const fields = o.shape === "sides"
      ? [["top", "Top (m)"], ["right", "Right (m)"], ["bottom", "Bottom (m)"], ["left", "Left (m)"]]
      : [["len", "Length (m)"], ["wid", "Width (m)"]];
    const grid = document.createElement("div");
    grid.className = "row";
    for (const [key, text] of fields) {
      const lab = document.createElement("label");
      lab.textContent = `${text} `;
      const inp = document.createElement("input");
      Object.assign(inp, { type: "number", step: "0.1", min: "0.1", max: "100", inputMode: "decimal", placeholder: "m" });
      if (o.vals[key] > 0) inp.value = o.vals[key];
      inp.addEventListener("input", () => { o.vals[key] = parseFloat(inp.value); markStale(); });
      lab.append(inp);
      grid.append(lab);
    }
    li.append(grid);
    ul.append(li);
  });
}

// Picture for the downloadable report (report.js): the to-scale plan when there is one, else the photo with
// the mask and panels on top.
window.SolarScopeReportImage = () => {
  if (!state.w) return null;
  if (!$("#photoPlanBox").hidden) return planCv;
  const c = document.createElement("canvas");
  c.width = imgCv.width;
  c.height = imgCv.height;
  const g = c.getContext("2d");
  g.drawImage(imgCv, 0, 0);
  g.drawImage(ovCv, 0, 0, c.width, c.height);
  return c;
};

// ---------- startup ----------

async function init() {
  showGsd();
  setupLocation();
  try {
    state.defaults = (await loadConfig()).layout_defaults;
  } catch (_) {
    setStatus("Could not reach the server.", "error");
  }

  try {
    const samples = await (await fetch("samples/samples.json")).json();
    const box = $("#samples");
    for (const s of samples) {
      const b = document.createElement("button");
      b.title = s.title;
      b.innerHTML = `<img src="samples/${s.file}" alt="${s.title}">`;
      b.addEventListener("click", async () => {
        const blob = await (await fetch(`samples/${s.file}`)).blob();
        await loadImage(blob, { gsd: s.gsd_m, lat: s.lat, lon: s.lon });
      });
      box.appendChild(b);
    }
  } catch (_) { /* samples are optional */ }
}

init();
