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
    undo: [], roofPoint: null, roofBox: null, panels: [], calib: null, calibrating: false, zoom: 1,
  });
  state.imgBlob = await new Promise((res) => imgCv.toBlob(res, "image/png"));

  if (meta.gsd) $("#gsd").value = meta.gsd;
  setGsdFromInput();
  if (meta.lat !== undefined) { $("#lat").value = meta.lat; $("#lon").value = meta.lon; }

  $("#placeholder").hidden = true;
  $("#canvasBox").hidden = false;
  $("#zoombar").hidden = false;
  $("#report").hidden = true;
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
  stage.scrollLeft += r2.left + fx * r2.width - clientX;
  stage.scrollTop += r2.top + fy * r2.height - clientY;
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
  $("#brushVal").textContent = `${state.brush} px ≈ ${brushM.toFixed(2)} m`;
}

$("#gsd").addEventListener("input", () => { setGsdFromInput(); markStale(); });

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
  showGsd();
  markStale();
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
    for (const [x, y, w, h] of state.panels) {
      octx.fillRect(x, y, w, h);
      octx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
    }
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
  state.undo.push(state.mask.slice());
  if (state.undo.length > 20) state.undo.shift();
  updateUndo();
}
function updateUndo() { $("#undoBtn").disabled = state.undo.length === 0; }

function markStale() {
  if (state.panels.length) {
    state.panels = [];
    setStatus("Mask or scale changed — compute the report again.");
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
    stage.scrollLeft = state.panning.sl - (e.clientX - state.panning.x);
    stage.scrollTop = state.panning.st - (e.clientY - state.panning.y);
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
}
ovCv.addEventListener("pointerup", endStroke);
ovCv.addEventListener("pointercancel", endStroke);

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    state.tool = b.dataset.tool;
    document.querySelectorAll(".tool").forEach((t) => t.classList.toggle("active", t === b));
  });
}
$("#brush").addEventListener("input", (e) => { state.brush = Number(e.target.value); showGsd(); });
$("#undoBtn").addEventListener("click", () => {
  const prev = state.undo.pop();
  if (prev) { state.mask = prev; markStale(); render(); }
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
  markStale();
  render();
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
  const rep = await postReport({
    width: state.w,
    height: state.h,
    mask_b64: b64FromBytes(state.mask),
    gsd_m: state.gsd,
    roof_point: state.roofPoint,
    roof_box: state.roofBox,
    ...reportSettings(),
  });
  state.panels = rep.panels;
  render();
  showReport(rep);
  setStatus(rep.panel_count
    ? `${rep.panel_count} panels fit after setbacks.`
    : "No panel fits. Check the scale, the setback or the roof mask.");
}));

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
