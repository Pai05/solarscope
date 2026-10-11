"use strict";
// Scan page: roof outline (AR area scan or typed size) -> digital floor plan -> panels -> report.
// Needs common.js. The plan is rasterized into the same 3-class mask the image page sends to /report,
// so panel layout and economics reuse the tested backend.

const MARGIN_M = 0.6;           // empty border around the roof in the plan (metres)
const PLAN_MAX_PX = 1800;       // mask side limit (backend accepts up to 2048)
const OBS_TYPES = ["Water tank", "Stair room", "AC unit", "Solar heater", "Other"];

const plan = {
  roof: null,             // [[x, y], ...] metres, plan frame (x right, y down)
  obstructions: [],       // [{label, pts}]
  panels: [],             // [[x, y, w, h, small], ...] metres; small = gap-filling panel
  source: "",
  sel: -1,
  drag: null,
  view: null,             // {s, ox, oy} metres -> canvas px
};
const cv = $("#plan");
const ctx = cv.getContext("2d");

// ---------- geometry ----------

const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;  // signed
};
const perimeter = (pts) => pts.reduce((p, q, i) => {
  const r = pts[(i + 1) % pts.length];
  return p + Math.hypot(r[0] - q[0], r[1] - q[1]);
}, 0);
const centroid = (pts) => {
  const n = pts.length;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
};
function inside([x, y], pts) {
  let inPoly = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inPoly = !inPoly;
  }
  return inPoly;
}
const bbox = (pts) => ({
  minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
  minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
});

// Rotate so the longest roof edge is horizontal (panel rows run along it), then move to the margin.
function normalize(roof, obstructions) {
  let best = 0, ang = 0;
  roof.forEach((p, i) => {
    const q = roof[(i + 1) % roof.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len > best) { best = len; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); }
  });
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const rot = (pts) => pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const r = rot(roof);
  const b = bbox(r);
  const tr = (pts) => pts.map(([x, y]) => [x - b.minX + MARGIN_M, y - b.minY + MARGIN_M]);
  return { roof: tr(r), obstructions: obstructions.map((o) => tr(rot(o))) };
}

// ---------- state changes ----------

function setRoof(roof, obstructionPolys, source) {
  const n = normalize(roof, obstructionPolys);
  plan.roof = n.roof;
  plan.obstructions = n.obstructions.map((pts, i) => ({ label: `Obstruction ${i + 1}`, pts }));
  plan.source = source;
  plan.sel = -1;
  changed(false);
  $("#planEmpty").hidden = true;
  markStep("capture", true);
  $("#reportBtn").disabled = false;
  $("#obsAdd").disabled = false;
  setStatus(`Roof outline ready (${source}). Add obstructions if needed, then compute the report.`);
}

function changed(stale = true) {
  if (stale && plan.panels.length) { setStatus("Plan changed — compute the report again."); reportStale(); }
  plan.panels = [];
  renderList();
  render();
}

function addObstruction(label, l, w) {
  if (!plan.roof) return;
  const b = bbox(plan.roof);
  // Drop it inside the roof near the top-left, shifted for each new one; the user drags it into place.
  const k = plan.obstructions.length;
  let x = b.minX + 0.8 + (k % 4) * (l + 0.4), y = b.minY + 0.8 + Math.floor(k / 4) * (w + 0.4);
  x = Math.min(x, b.maxX - l - 0.1);
  y = Math.min(y, b.maxY - w - 0.1);
  plan.obstructions.push({ label, pts: [[x, y], [x + l, y], [x + l, y + w], [x, y + w]] });
  plan.sel = plan.obstructions.length - 1;
  changed();
  setStatus(`${label} added. Drag it on the plan to where it really is.`);
}

function removeObstruction(i) {
  plan.obstructions.splice(i, 1);
  plan.sel = -1;
  changed();
}

function renderList() {
  markStep("correct", plan.obstructions.length > 0);  // optional step: done once something is marked
  const ul = $("#obsList");
  ul.innerHTML = "";
  plan.obstructions.forEach((o, i) => {
    const li = document.createElement("li");
    li.className = i === plan.sel ? "sel" : "";
    li.innerHTML = `<span>${o.label}</span><span class="muted small">${Math.abs(area(o.pts)).toFixed(1)} m²</span>`;
    const del = document.createElement("button");
    del.className = "secondary icon";
    del.title = "Remove";
    del.textContent = "✕";
    del.addEventListener("click", () => removeObstruction(i));
    li.appendChild(del);
    li.addEventListener("click", (e) => { if (e.target !== del) { plan.sel = i; renderList(); render(); } });
    ul.appendChild(li);
  });
  const info = $("#planInfo");
  if (!plan.roof) { info.textContent = ""; return; }
  const ra = Math.abs(area(plan.roof));
  const oa = plan.obstructions.reduce((s, o) => s + Math.abs(area(o.pts)), 0);
  info.textContent = `Roof ${ra.toFixed(1)} m² · perimeter ${perimeter(plan.roof).toFixed(1)} m · `
    + `${plan.obstructions.length} obstruction${plan.obstructions.length === 1 ? "" : "s"} (${oa.toFixed(1)} m²) · from ${plan.source}`;
}

// ---------- rasterize & compute ----------

function rasterize() {
  const b = bbox(plan.roof);
  const W = b.maxX + MARGIN_M, H = b.maxY + MARGIN_M;
  const gsd = Math.max(0.05, Math.max(W, H) / PLAN_MAX_PX);
  const w = Math.ceil(W / gsd), h = Math.ceil(H / gsd);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  const path = (pts) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x / gsd, y / gsd) : g.moveTo(x / gsd, y / gsd)));
    g.closePath();
  };
  g.fillStyle = "rgb(255,0,0)";
  path(plan.roof);
  g.fill();
  g.fillStyle = "rgb(0,255,0)";
  for (const o of plan.obstructions) { path(o.pts); g.fill(); }
  const d = g.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) mask[i] = d[j + 1] > 127 ? 2 : d[j] > 127 ? 1 : 0;
  return { mask, w, h, gsd };
}

$("#reportBtn").addEventListener("click", (e) => busy(e.currentTarget, "Laying out panels on your roof…", async () => {
  if (!plan.roof) throw new Error("Scan the roof or type its size first.");
  const r = rasterize();
  const rep = await postReport({ width: r.w, height: r.h, mask_b64: b64FromBytes(r.mask), gsd_m: r.gsd, ...reportSettings() });
  // [x, y, w, h, small] in metres; small = gap-filling panel, drawn in teal.
  const toM = (small) => ([x, y, w, h]) => [x * r.gsd, y * r.gsd, w * r.gsd, h * r.gsd, small];
  plan.panels = rep.panels.map(toM(false)).concat((rep.small_panels || []).map(toM(true)));
  // Room for more panels beyond the budget: drawn as dashed outlines.
  plan.spare = rep.budget ? rep.budget.spare_panels.concat(rep.budget.spare_small_panels).map(toM(false)) : [];
  render();
  const rb = bbox(plan.roof);
  const dims = { L: rb.maxX - rb.minX, W: rb.maxY - rb.minY };
  showReport(rep, dims);
  if (rep.panel_count) {
    const nSmall = (rep.small_panels || []).length;
    setStatus(`${rep.panel_count} panels (${fmt(rep.capacity_kw, 2)} kWp) fit on your roof`
      + (nSmall ? `: ${rep.panel_count - nSmall} standard + ${nSmall} small in the leftover space.` : ".")
      + (rep.budget?.limited ? ` Sized to your budget; the roof can hold ${rep.budget.roof_max.panel_count}.` : ""));
  } else {
    // Say why in numbers: usually the scanned area is smaller than one panel plus the edge gap.
    const s = reportSettings();
    const sp = smallestPanel(s);
    const minL = Math.max(sp.w, sp.h) + 2 * s.setback_m;
    const minW = Math.min(sp.w, sp.h) + 2 * s.setback_m;
    setStatus(`No panel fits. The roof is about ${fmt(rb.maxX - rb.minX, 1)} m × ${fmt(rb.maxY - rb.minY, 1)} m; `
      + `the smallest ${fmt(sp.w, 2)} × ${fmt(sp.h, 2)} m panel with a ${fmt(s.setback_m, 1)} m edge gap `
      + `needs at least ${fmt(minL, 1)} m × ${fmt(minW, 1)} m free of obstructions. `
      + (setbackAdvice(dims.L, dims.W, s) || "Move or remove obstructions, or lower the edge setback."), "error");
  }
}));

// ---------- drawing ----------

function niceStep(m) {
  for (const s of [0.5, 1, 2, 5, 10, 20, 50]) if (s >= m) return s;
  return 100;
}

function render() {
  const box = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  cv.hidden = !plan.roof;  // an empty canvas would still take 300 px and squeeze the placeholder
  if (!plan.roof) return;
  const cw = box.clientWidth - 18;  // clientWidth includes the stage's 8 px padding on each side
  const b = bbox(plan.roof);
  const W = b.maxX + MARGIN_M, H = b.maxY + MARGIN_M;
  const ch = Math.min(Math.max(320, window.innerHeight * 0.68), Math.max(260, (cw * H) / W + 40));
  cv.style.width = `${cw}px`;
  cv.style.height = `${ch}px`;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const pad = 44;
  const s = Math.min((cw - 2 * pad) / W, (ch - 2 * pad) / H);
  const ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
  plan.view = { s, ox, oy };
  const X = (x) => ox + x * s, Y = (y) => oy + y * s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  // Theme colours from styles.css (--ink is the text colour; there is no --text, which made every label
  // fall back to near-black and vanish on the dark theme).
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink").trim() || "#0a1633";
  const surface = css.getPropertyValue("--surface").trim() || "#ffffff";
  // Text on a solid rounded label: readable over the grid, roof fill and edges, in both themes, and in the
  // saved PNG (transparent background) whatever it is viewed on.
  const pill = (label, x, y, { bg = surface, fg = ink, border = "rgba(128,128,128,0.6)", align = "center" } = {}) => {
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const w = ctx.measureText(label).width + 12, h = 20;
    const left = align === "left" ? x : x - w / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, y - h / 2, w, h, 6); else ctx.rect(left, y - h / 2, w, h);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = border;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.fillText(label, left + w / 2, y + 0.5);
  };

  // 1 m grid, stronger every 5 m
  for (let m = 0; m <= Math.max(W, H); m += 1) {
    ctx.strokeStyle = m % 5 === 0 ? "rgba(128,128,128,0.28)" : "rgba(128,128,128,0.12)";
    ctx.lineWidth = 1;
    if (m <= W) { ctx.beginPath(); ctx.moveTo(X(m), Y(0)); ctx.lineTo(X(m), Y(H)); ctx.stroke(); }
    if (m <= H) { ctx.beginPath(); ctx.moveTo(X(0), Y(m)); ctx.lineTo(X(W), Y(m)); ctx.stroke(); }
  }

  const path = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
  };

  // Roof, with the edge setback zone shaded inside its border
  path(plan.roof);
  ctx.fillStyle = "rgba(34,197,94,0.20)";
  ctx.fill();
  const setback = num("#setback") ?? LAYOUT_DEFAULTS?.setback_m ?? 0.3;
  const buffer = num("#buffer") ?? LAYOUT_DEFAULTS?.obstruction_buffer_m ?? 0.3;
  ctx.save();
  path(plan.roof);
  ctx.clip();
  ctx.lineWidth = 2 * setback * s;
  ctx.strokeStyle = "rgba(245,158,11,0.28)";
  path(plan.roof);
  ctx.stroke();
  for (const o of plan.obstructions) {
    ctx.lineWidth = 2 * buffer * s;
    ctx.strokeStyle = "rgba(239,68,68,0.18)";
    path(o.pts);
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#16a34a";
  path(plan.roof);
  ctx.stroke();

  // Over-budget room for more panels: dashed outlines only
  if (plan.panels.length) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.55;
    for (const [x, y, w, h] of plan.spare || []) ctx.strokeRect(X(x) + 1.5, Y(y) + 1.5, w * s - 3, h * s - 3);
    ctx.restore();
  }

  // Panels
  for (const [x, y, w, h, small] of plan.panels) {
    const px = X(x), py = Y(y), pw = w * s, ph = h * s;
    const grad = ctx.createLinearGradient(px, py, px + pw, py + ph);
    grad.addColorStop(0, small ? "#115e59" : "#1e3a8a");  // small gap-fillers teal, standard blue
    grad.addColorStop(1, small ? "#0d9488" : "#2563eb");
    ctx.fillStyle = grad;
    ctx.fillRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = "rgba(219,234,254,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = "rgba(219,234,254,0.35)";  // cell lines
    ctx.beginPath();
    if (pw >= ph) { for (let k = 1; k < 3; k++) { ctx.moveTo(px + (pw * k) / 3, py); ctx.lineTo(px + (pw * k) / 3, py + ph); } }
    else { for (let k = 1; k < 3; k++) { ctx.moveTo(px, py + (ph * k) / 3); ctx.lineTo(px + pw, py + (ph * k) / 3); } }
    ctx.stroke();
  }

  // Obstructions
  plan.obstructions.forEach((o, i) => {
    path(o.pts);
    ctx.fillStyle = "rgba(239,68,68,0.6)";
    ctx.fill();
    ctx.lineWidth = i === plan.sel ? 2.5 : 1.5;
    ctx.setLineDash(i === plan.sel ? [6, 4] : []);
    ctx.strokeStyle = "#b91c1c";
    ctx.stroke();
    ctx.setLineDash([]);
    const [cx, cy] = centroid(o.pts);
    pill(o.label, X(cx), Y(cy), { bg: "#7f1d1d", fg: "#ffffff", border: "#fecaca" });
  });

  // Edge lengths, written just outside each roof edge
  const ccw = area(plan.roof) < 0;  // y points down, so the sign flips the usual meaning
  plan.roof.forEach((p, i) => {
    const q = plan.roof[(i + 1) % plan.roof.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len * s < 28) return;
    let nx = q[1] - p[1], ny = -(q[0] - p[0]);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    if (ccw) { nx = -nx; ny = -ny; }
    const mx = X((p[0] + q[0]) / 2) + nx * 18, my = Y((p[1] + q[1]) / 2) + ny * 18;
    pill(`${len.toFixed(2)} m`, mx, my, { border: "#16a34a" });
  });

  // Scale bar
  const step = niceStep(80 / s);
  const sx = 14, sy = ch - 16;
  // Bar in the text colour over a halo of the surface colour: visible on the page in both themes and on the
  // white background of the downloaded report.
  ctx.beginPath();
  ctx.moveTo(sx, sy - 6); ctx.lineTo(sx, sy); ctx.lineTo(sx + step * s, sy); ctx.lineTo(sx + step * s, sy - 6);
  ctx.lineJoin = "round";
  ctx.strokeStyle = surface;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  pill(`${step} m`, sx + step * s + 6, sy - 4, { align: "left" });
}
window.addEventListener("resize", render);
document.addEventListener("themechange", render);  // labels use theme colours
$("#setback")?.addEventListener("input", () => changed());
$("#buffer")?.addEventListener("input", () => changed());
$("#budget")?.addEventListener("input", () => changed());
$("#budgetBasis")?.addEventListener("change", () => changed());

// ---------- dragging obstructions ----------

function toMetres(e) {
  const r = cv.getBoundingClientRect();
  const k = pageZoom(cv);
  const { s, ox, oy } = plan.view;
  return [((e.clientX - r.left) / k - ox) / s, ((e.clientY - r.top) / k - oy) / s];
}
cv.addEventListener("pointerdown", (e) => {
  if (!plan.roof || !plan.view) return;
  const p = toMetres(e);
  for (let i = plan.obstructions.length - 1; i >= 0; i--) {
    if (inside(p, plan.obstructions[i].pts)) {
      plan.sel = i;
      plan.drag = { i, last: p };
      cv.setPointerCapture(e.pointerId);
      renderList();
      render();
      return;
    }
  }
  plan.sel = -1;
  renderList();
  render();
});
cv.addEventListener("pointermove", (e) => {
  if (!plan.drag) {
    if (plan.view && plan.roof) {
      const p = toMetres(e);
      cv.style.cursor = plan.obstructions.some((o) => inside(p, o.pts)) ? "grab" : "default";
    }
    return;
  }
  const p = toMetres(e);
  const dx = p[0] - plan.drag.last[0], dy = p[1] - plan.drag.last[1];
  plan.drag.last = p;
  const o = plan.obstructions[plan.drag.i];
  o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  if (plan.panels.length) { plan.panels = []; setStatus("Plan changed — compute the report again."); reportStale(); }
  render();
});
const endDrag = () => { if (plan.drag) { plan.drag = null; renderList(); } };
cv.addEventListener("pointerup", endDrag);
cv.addEventListener("pointercancel", endDrag);
window.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && plan.sel >= 0 && !["INPUT", "SELECT"].includes(e.target.tagName)) {
    removeObstruction(plan.sel);
  }
});

// ---------- inputs ----------

$("#manualBtn").addEventListener("click", () => {
  const l = num("#roofL"), w = num("#roofW");
  if (!l || !w || l <= 0 || w <= 0) { setStatus("Type the roof length and width in metres.", "error"); return; }
  setRoof([[0, 0], [l, 0], [l, w], [0, w]], [], "typed size");
  if (window.matchMedia("(max-width: 900px)").matches) $("#planCard").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#obsType").innerHTML = OBS_TYPES.map((t) => `<option>${t}</option>`).join("");
$("#obsAdd").addEventListener("click", () => {
  const l = num("#obsL"), w = num("#obsW");
  if (!l || !w || l <= 0 || w <= 0) { setStatus("Type the obstruction length and width in metres.", "error"); return; }
  const type = $("#obsType").value;
  const same = plan.obstructions.filter((o) => o.label.startsWith(type)).length;
  addObstruction(same ? `${type} ${same + 1}` : type, l, w);
});

$("#savePlan").addEventListener("click", () => {
  if (!plan.roof) return;
  const a = document.createElement("a");
  a.download = "solarscope-plan.png";
  a.href = cv.toDataURL("image/png");
  a.click();
});

// Picture for the downloadable report (report.js): the plan canvas as drawn, panels included.
window.SolarScopeReportImage = () => (plan.roof ? cv : null);

// Called by ar.js when an AR area scan finishes: {roof: [[x, z], ...], obstructions: [[[x, z], ...], ...]}
window.SolarScopeApplyARArea = (r) => {
  if (!r?.roof || r.roof.length < 3) { setStatus("The scan needs at least 3 roof corners.", "error"); return; }
  setRoof(r.roof, r.obstructions || [], "AR scan");
  $("#planCard").scrollIntoView({ behavior: "smooth", block: "start" });
};

// ---------- startup ----------

(async function init() {
  setupLocation();
  try { await loadConfig(); } catch (_) { setStatus("Could not reach the server.", "error"); }
  renderList();
})();
