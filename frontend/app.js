"use strict";

// Working image is at most MAX_SIDE px; mask, brush, calibration and report all use its pixels.
const MAX_SIDE = 1024;
const OVERLAY_ALPHA = 110;
const CLASS_RGB = { 1: [34, 197, 94], 2: [239, 68, 68] };

const $ = (s) => document.querySelector(s);
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
  calib: null,        // {a, b} while calibrating
  calibrating: false,
  painting: false,
  last: null,
  panels: [],
  defaults: null,
};

// ---------- helpers ----------

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status " + kind;
}

async function busy(btn, msg, fn) {
  btn.disabled = true;
  setStatus(msg, "busy");
  try {
    await fn();
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    btn.disabled = false;
  }
}

async function apiError(r) {
  try {
    const j = await r.json();
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) return j.detail.map((d) => `${d.loc.slice(-1)[0]}: ${d.msg}`).join("; ");
  } catch (_) { /* not JSON */ }
  return `Server error (${r.status})`;
}

function b64FromBytes(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v))
  ? "–" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };

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
    undo: [], roofPoint: null, panels: [], calib: null, calibrating: false,
  });
  state.imgBlob = await new Promise((res) => imgCv.toBlob(res, "image/png"));

  if (meta.gsd) $("#gsd").value = meta.gsd;
  setGsdFromInput();
  if (meta.lat !== undefined) { $("#lat").value = meta.lat; $("#lon").value = meta.lon; }

  $("#placeholder").hidden = true;
  $("#canvasBox").hidden = false;
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
  const maxW = stage.clientWidth - 16;
  const maxH = Math.max(320, window.innerHeight * 0.72);
  const s = Math.min(maxW / state.w, maxH / state.h);
  for (const c of [imgCv, ovCv]) {
    c.style.width = `${Math.floor(state.w * s)}px`;
    c.style.height = `${Math.floor(state.h * s)}px`;
  }
}
window.addEventListener("resize", fitCanvas);

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

// ---------- location ----------

$("#locBtn").addEventListener("click", () => {
  if (!navigator.geolocation) { setStatus("Location is not available in this browser.", "error"); return; }
  setStatus("Getting location…", "busy");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $("#lat").value = p.coords.latitude.toFixed(4);
      $("#lon").value = p.coords.longitude.toFixed(4);
      setStatus("Location set.");
    },
    (e) => setStatus(`Location failed: ${e.message}. Type latitude/longitude instead.`, "error"),
    { timeout: 10000 },
  );
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
  const p = pos(e);
  if (state.calibrating) {
    state.calib = { a: p, b: p };
    state.painting = true;
    return;
  }
  if (state.tool === "point") {
    state.roofPoint = [Math.round(p.x), Math.round(p.y)];
    markStale();
    render();
    setStatus("Roof selected. Only this building will be analysed.");
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
  if (!state.painting) return;
  const p = pos(e);
  if (state.calibrating) state.calib.b = p;
  else strokeTo(p);
  scheduleRender();
});

function endStroke() {
  if (!state.painting) return;
  state.painting = false;
  state.last = null;
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
  const overrides = {};
  if (num("#tariff") !== null) overrides.tariff_inr_per_kwh = num("#tariff");
  if (num("#cost") !== null) overrides.installed_cost_inr_per_kw = num("#cost");
  const body = {
    width: state.w,
    height: state.h,
    mask_b64: b64FromBytes(state.mask),
    gsd_m: state.gsd,
    lat: num("#lat"),
    lon: num("#lon"),
    roof_point: state.roofPoint,
    setback_m: num("#setback") ?? state.defaults?.setback_m,
    obstruction_buffer_m: num("#buffer") ?? state.defaults?.obstruction_buffer_m,
    panel_w_m: num("#panelW") ?? state.defaults?.panel_w_m,
    panel_h_m: num("#panelH") ?? state.defaults?.panel_h_m,
    panel_wp: num("#panelWp") ?? state.defaults?.panel_wp,
    overrides,
  };
  for (const k of Object.keys(body)) if (body[k] === null || body[k] === undefined) delete body[k];
  const r = await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await apiError(r));
  const rep = await r.json();
  state.panels = rep.panels;
  render();
  showReport(rep);
  setStatus(rep.panel_count
    ? `${rep.panel_count} panels fit after setbacks.`
    : "No panel fits. Check the scale, the setback or the roof mask.");
}));

// ---------- report ----------

const LABELS = {
  ghi_kwh_m2_day: "Solar irradiance",
  performance_ratio: "Performance ratio",
  tariff_inr_per_kwh: "Electricity tariff",
  installed_cost_inr_per_kw: "Installed cost",
  subsidy_tier1_inr_per_kw: "Subsidy, tier 1 rate",
  subsidy_tier1_kw: "Subsidy, tier 1 size",
  subsidy_tier2_inr_per_kw: "Subsidy, tier 2 rate",
  subsidy_tier2_kw: "Subsidy, tier 2 size",
  subsidy_cap_inr: "Subsidy cap",
  grid_emission_kg_per_kwh: "Grid emission factor",
  panel_size_m: "Panel size",
  panel_wp: "Panel power",
  setback_m: "Edge setback",
  obstruction_buffer_m: "Obstruction buffer",
  gsd_m: "Image scale",
};

function rows(el, items) {
  el.innerHTML = "";
  for (const [k, v] of items) {
    const tr = el.insertRow();
    tr.insertCell().textContent = k;
    const td = tr.insertCell();
    td.className = "num";
    td.textContent = v;
  }
}

function showReport(rep) {
  $("#report").hidden = false;
  $("#kPanels").textContent = fmt(rep.panel_count);
  $("#kKw").textContent = fmt(rep.capacity_kw, 2);
  $("#kKwh").textContent = fmt(rep.annual_generation_kwh);
  $("#kSave").textContent = fmt(rep.annual_savings_inr);
  $("#kPay").textContent = rep.payback_years === null ? "–" : fmt(rep.payback_years, 1);
  $("#kCo2").textContent = fmt(rep.co2_avoided_kg_per_year / 1000, 2);

  const a = rep.areas_m2;
  rows($("#areas"), [
    ["Roof area (incl. obstructions)", `${fmt(a.roof_total, 1)} m²`],
    ["Obstructions", `${fmt(a.obstructions, 1)} m²`],
    ["Free roof", `${fmt(a.roof_free, 1)} m²`],
    ["Usable after setbacks", `${fmt(a.usable_after_setback, 1)} m²`],
    ["Covered by panels", `${fmt(a.covered_by_panels, 1)} m² (${rep.panel_orientation})`],
    ["Specific yield", `${fmt(rep.specific_yield_kwh_per_kwp)} kWh/kWp/yr`],
  ]);
  rows($("#costs"), [
    ["System cost", `₹ ${fmt(rep.gross_cost_inr)}`],
    ["Subsidy", `− ₹ ${fmt(rep.subsidy_inr)}`],
    ["Net cost", `₹ ${fmt(rep.net_cost_inr)}`],
    ["Savings per year", `₹ ${fmt(rep.annual_savings_inr)}`],
    ["Simple payback", rep.payback_years === null ? "–" : `${fmt(rep.payback_years, 1)} years`],
  ]);

  const tb = $("#assumptions");
  tb.innerHTML = "";
  for (const [k, x] of Object.entries(rep.assumptions)) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = LABELS[k] || k;
    tr.insertCell().textContent = `${typeof x.value === "number" ? fmt(x.value, x.value < 10 ? 3 : 0) : x.value} ${x.unit}`;
    tr.insertCell().textContent = x.source;
    const chip = document.createElement("span");
    chip.className = x.verified ? "ok-chip" : "todo-chip";
    chip.textContent = x.verified ? "verified" : "to verify";
    tr.insertCell().appendChild(chip);
  }
  $("#unverified").hidden = rep.all_assumptions_verified;
  $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- startup ----------

async function init() {
  showGsd();
  try {
    const cfg = await (await fetch("/config")).json();
    const d = cfg.layout_defaults;
    state.defaults = d;
    $("#setback").value = d.setback_m;
    $("#buffer").value = d.obstruction_buffer_m;
    $("#panelW").value = d.panel_w_m;
    $("#panelH").value = d.panel_h_m;
    $("#panelWp").value = d.panel_wp;
    const badge = $("#modelBadge");
    if (cfg.model.available) {
      const miou = cfg.model.metrics?.miou;
      badge.textContent = `Model: ${cfg.model.arch || "U-Net"}${miou ? ` · mIoU ${miou.toFixed(2)}` : ""}`;
      badge.className = "badge ok";
    } else {
      badge.textContent = "Model offline — paint by hand";
      badge.className = "badge off";
    }
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
