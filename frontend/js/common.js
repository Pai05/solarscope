"use strict";
// Shared by image.html (app.js), scan.html (plan.js) and installers.html (installers.js): DOM helpers, API helpers, settings and the report card.

const $ = (s) => document.querySelector(s);

function setStatus(msg, kind = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = msg;
  el.className = "status " + kind;
}

async function busy(btn, msg, fn) {
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  setStatus(msg, "busy");
  try {
    await fn();
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
  }
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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

// Screen pixels per CSS pixel for an element (>1 when styles.css zooms the page on wide screens).
// Mouse/touch clientX/Y are screen pixels; element sizes, scroll offsets and canvas maths are CSS pixels.
const pageZoom = (el) => (el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1) || 1;

// Largest edge setback (m) that still lets one panel fit on an L x W rectangle, trying both panel
// orientations; rounded down to 5 cm with 1 cm spare for the pixel grid. Negative: no setback is small enough.
function maxSetbackForPanel(L, W, panelW, panelH) {
  const long = Math.max(L, W), short = Math.min(L, W);
  const a = Math.max(panelW, panelH), b = Math.min(panelW, panelH);
  const best = Math.max(Math.min((long - a) / 2, (short - b) / 2), Math.min((long - b) / 2, (short - a) / 2));
  return best < 0 ? best : Math.floor((best - 0.01) / 0.05) * 0.05;
}

// Smallest panel the layout may use with settings s: the small gap-filler when it is on and really smaller.
function smallestPanel(s) {
  const std = { w: s.panel_w_m, h: s.panel_h_m };
  if (!s.fill_small_panels) return std;
  const small = { w: s.small_panel_w_m, h: s.small_panel_h_m };
  return small.w * small.h < std.w * std.h ? small : std;
}

// What to do when no panel fits on an L x W roof with settings s: the exact setback that would work, or why not.
function setbackAdvice(L, W, s) {
  const p = smallestPanel(s);
  const m = maxSetbackForPanel(L, W, p.w, p.h);
  if (m >= s.setback_m) return "";  // the rectangle fits: obstructions or an odd shape are in the way
  if (m >= 0) return `Set Edge setback (Layout settings) to ${fmt(m, 2)} m or less and a panel fits.`;
  return `Even with no edge gap the roof is smaller than one ${fmt(p.w, 2)} × ${fmt(p.h, 2)} m panel: `
    + "measure the whole roof, or enter your own (smaller) panel size in Layout settings.";
}

const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v))
  ? "–" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const num = (id) => { const el = $(id); const v = el ? parseFloat(el.value) : NaN; return Number.isFinite(v) ? v : null; };

// ---------- settings & config ----------

let LAYOUT_DEFAULTS = null;

async function loadConfig() {
  const cfg = await (await fetch("/config")).json();
  const d = cfg.layout_defaults;
  LAYOUT_DEFAULTS = d;
  const set = (id, v) => { const el = $(id); if (el && el.value === "") el.value = v; };
  set("#setback", d.setback_m);
  set("#buffer", d.obstruction_buffer_m);
  set("#panelW", d.panel_w_m);
  set("#panelH", d.panel_h_m);
  set("#panelWp", d.panel_wp);
  set("#smallPanelW", d.small_panel_w_m);
  set("#smallPanelH", d.small_panel_h_m);
  set("#smallPanelWp", d.small_panel_wp);
  const badge = $("#modelBadge");
  if (badge) {
    if (cfg.model.available) {
      const miou = cfg.model.metrics?.miou;
      badge.textContent = `Model: ${cfg.model.arch || "U-Net"}${miou ? ` · mIoU ${miou.toFixed(2)}` : ""}`;
      badge.className = "badge ok";
    } else {
      badge.textContent = "Model offline — paint by hand";
      badge.className = "badge off";
    }
  }
  return cfg;
}

// Layout + money settings shared by both pages, ready to merge into a /report body.
function reportSettings() {
  const d = LAYOUT_DEFAULTS || {};
  const overrides = {};
  if (num("#tariff") !== null) overrides.tariff_inr_per_kwh = num("#tariff");
  if (num("#cost") !== null) overrides.installed_cost_inr_per_kw = num("#cost");
  return {
    lat: num("#lat"),
    lon: num("#lon"),
    setback_m: num("#setback") ?? d.setback_m,
    obstruction_buffer_m: num("#buffer") ?? d.obstruction_buffer_m,
    panel_w_m: num("#panelW") ?? d.panel_w_m,
    panel_h_m: num("#panelH") ?? d.panel_h_m,
    panel_wp: num("#panelWp") ?? d.panel_wp,
    fill_small_panels: $("#fillSmall") ? $("#fillSmall").checked : (d.fill_small_panels ?? true),
    small_panel_w_m: num("#smallPanelW") ?? d.small_panel_w_m,
    small_panel_h_m: num("#smallPanelH") ?? d.small_panel_h_m,
    small_panel_wp: num("#smallPanelWp") ?? d.small_panel_wp,
    budget_inr: num("#budget") > 0 ? num("#budget") : null,  // empty: fill the whole roof
    budget_basis: $("#budgetBasis")?.value || "net",
    overrides,
  };
}

async function postReport(body) {
  for (const k of Object.keys(body)) if (body[k] === null || body[k] === undefined) delete body[k];
  const r = await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await apiError(r));
  return r.json();
}

function setupLocation() {
  const btn = $("#locBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) { setStatus("Location is not available in this browser.", "error"); return; }
    setStatus("Getting location…", "busy");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        $("#lat").value = p.coords.latitude.toFixed(4);
        $("#lon").value = p.coords.longitude.toFixed(4);
        setStatus("Location set.");
        updateSteps();
      },
      (e) => setStatus(`Location failed: ${e.message}. Type latitude/longitude instead.`, "error"),
      { timeout: 10000 },
    );
  });
}

// ---------- report card ----------

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
  small_panel_size_m: "Small panel size",
  small_panel_wp: "Small panel power",
  setback_m: "Edge setback",
  obstruction_buffer_m: "Obstruction buffer",
  gsd_m: "Plan / image scale",
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

// One-line summary of how the budget shaped the plan, or "" without a budget (also used by the report file).
function budgetSummary(rep) {
  const b = rep.budget;
  if (!b) return "";
  const basis = b.basis === "net" ? "after subsidy" : "upfront";
  const cost = b.basis === "net" ? rep.net_cost_inr : rep.gross_cost_inr;
  const max = b.roof_max;
  const maxCost = b.basis === "net" ? max.net_cost_inr : max.gross_cost_inr;
  if (!rep.panel_count && max.panel_count) {
    return `Your budget of ₹ ${fmt(b.budget_inr)} (${basis}) is less than the cost of one panel. `
      + `The whole roof (${fmt(max.panel_count)} panels, ${fmt(max.capacity_kw, 2)} kWp) would cost ₹ ${fmt(maxCost)} ${basis}.`;
  }
  if (!b.limited) {
    return `Your budget of ₹ ${fmt(b.budget_inr)} (${basis}) covers the whole roof: ${fmt(rep.panel_count)} panels, `
      + `${fmt(rep.capacity_kw, 2)} kWp for ₹ ${fmt(cost)} ${basis}, ₹ ${fmt(b.left_inr)} to spare.`;
  }
  return `Planned for your budget of ₹ ${fmt(b.budget_inr)} (${basis}): ${fmt(rep.panel_count)} panels, `
    + `${fmt(rep.capacity_kw, 2)} kWp for ₹ ${fmt(cost)} ${basis} (₹ ${fmt(b.left_inr)} left). `
    + `Your roof can hold ${fmt(max.panel_count)} panels (${fmt(max.capacity_kw, 2)} kWp, ₹ ${fmt(maxCost)} ${basis}); `
    + "the dashed outlines on the plan show where you can add panels later.";
}

function showBudgetNote(rep) {
  const box = $("#budgetNote");
  if (!box) return;
  const text = budgetSummary(rep);
  box.hidden = !text;
  box.replaceChildren();
  if (!text) return;
  const title = document.createElement("strong");
  title.textContent = rep.budget.limited ? "Sized to your budget" : "Within your budget";
  const p = document.createElement("p");
  p.textContent = text;
  box.append(title, p);
}

// Panels table: each panel type with its size, power and count, the total, and the minimum panel size.
function showPanelMix(rep) {
  const box = $("#panelMix"), note = $("#panelNote");
  if (!box || !rep.panel_types) return;
  const body = $("#panelTypes");
  body.innerHTML = "";
  const used = rep.panel_types.filter((t) => t.count > 0 || t.name === "Standard");
  for (const t of used) {
    const tr = body.insertRow();
    tr.insertCell().textContent = t.name;
    tr.insertCell().textContent = `${fmt(t.w_m, 2)} × ${fmt(t.h_m, 2)}`;
    const p = tr.insertCell(); p.className = "num"; p.textContent = `${fmt(t.wp)} Wp`;
    const c = tr.insertCell(); c.className = "num"; c.textContent = fmt(t.count);
  }
  const tr = body.insertRow();
  tr.className = "total";
  tr.insertCell().textContent = "Total";
  tr.insertCell().textContent = "";
  const p = tr.insertCell(); p.className = "num"; p.textContent = `${fmt(rep.capacity_kw, 2)} kWp`;
  const c = tr.insertCell(); c.className = "num"; c.textContent = fmt(rep.panel_count);
  box.hidden = false;

  const m = rep.min_panel_size_m;
  const small = rep.panel_types.find((t) => t.name !== "Standard" && t.count > 0);
  note.textContent = `Minimum panel size in this layout: ${fmt(Math.max(m.w, m.h), 2)} m × ${fmt(Math.min(m.w, m.h), 2)} m `
    + "(no space smaller than this, after the edge gap, can hold a panel)."
    + (small ? ` The ${fmt(small.count)} small panel${small.count > 1 ? "s" : ""} fill corners and strips the standard `
      + "panels leave. They work at a different voltage: your installer wires them on a separate string / inverter input "
      + "or uses microinverters." : "");
  note.hidden = false;
}

// roofDims: optional {L, W} in metres of the roof outline, for exact advice when nothing fits.
function showReport(rep, roofDims) {
  $("#report").hidden = false;
  countUp($("#kPanels"), rep.panel_count);
  countUp($("#kKw"), rep.capacity_kw, 2);
  countUp($("#kKwh"), rep.annual_generation_kwh);
  countUp($("#kSave"), rep.annual_savings_inr);
  countUp($("#kPay"), rep.payback_years, 1);
  countUp($("#kCo2"), rep.co2_avoided_kg_per_year / 1000, 2);
  // Highlighted summary at the top of the report.
  countUp($("#hPanels"), rep.panel_count);
  countUp($("#hKw"), rep.capacity_kw, 2);
  countUp($("#hNet"), rep.net_cost_inr);
  if ($("#hGross")) $("#hGross").textContent = fmt(rep.gross_cost_inr);
  if ($("#hSub")) $("#hSub").textContent = fmt(rep.subsidy_inr);

  const a = rep.areas_m2;
  // Zero panels: say plainly that the area is too small, with the numbers, above the zeros.
  const noFit = $("#noFit");
  const budgetCut = rep.budget?.limited && rep.budget.roof_max.panel_count > 0;  // panels fit; the budget is the limit
  if (noFit) {
    noFit.hidden = rep.panel_count > 0 || budgetCut;
    if (!rep.panel_count) {
      const s = reportSettings();
      const p = smallestPanel(s);
      const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h);
      $("#noFitWhy").textContent = `The roof measured is ${fmt(a.roof_total, 1)} m², and only `
        + `${fmt(a.usable_after_setback, 1)} m² is left after the ${fmt(s.setback_m, 1)} m safety gap along the edges`
        + (a.obstructions > 0 ? " and around obstructions" : "")
        + `. The smallest panel is ${fmt(long, 2)} m × ${fmt(short, 2)} m, `
        + `so it needs a clear area of at least about ${fmt(long + 2 * s.setback_m, 1)} m × ${fmt(short + 2 * s.setback_m, 1)} m. `
        + ((roofDims && setbackAdvice(roofDims.L, roofDims.W, s))
          || "Measure the whole roof, check the scale, move obstructions, or reduce the edge setback.");
    }
  }
  showBudgetNote(rep);
  showPanelMix(rep);
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
  saveProject(rep);
  if (typeof onReportReady === "function") onReportReady(rep);  // report.js: download + history
  markStep("report", true);
  $("#report").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

// Animate a number from 0 to `value` (formatted like fmt). Shows the final value at once under reduced motion.
function countUp(el, value, digits = 0) {
  if (!el) return;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) { el.textContent = "–"; return; }
  const end = Number(value);
  el.dataset.countTo = String(end);
  if (reducedMotion() || end === 0) { el.textContent = fmt(end, digits); return; }
  const t0 = performance.now(), dur = 900;
  const tick = (t) => {
    if (el.dataset.countTo !== String(end)) return;  // a newer report took over
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(k < 1 ? end * eased : end, digits);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- installer information ----------
// The key results go to sessionStorage (this tab only, never in the URL) for installers.html.

const PROJECT_KEY = "solarscope.project";

function saveProject(rep) {
  const s = reportSettings();
  const project = {
    panel_count: rep.panel_count,
    capacity_kw: rep.capacity_kw,
    gross_cost_inr: rep.gross_cost_inr,
    subsidy_inr: rep.subsidy_inr,
    net_cost_inr: rep.net_cost_inr,
    lat: s.lat,
    lon: s.lon,
    from: location.pathname,
  };
  try { sessionStorage.setItem(PROJECT_KEY, JSON.stringify(project)); } catch (_) { /* storage blocked */ }
  const btn = $("#installerBtn");
  if (btn) btn.disabled = false;
}

// Called whenever the report no longer matches the roof/settings on screen.
function reportStale() {
  for (const id of ["#installerBtn", "#downloadReport", "#printReport"]) { const b = $(id); if (b) b.disabled = true; }
  markStep("report", false);
}

function loadProject() {
  try { return JSON.parse(sessionStorage.getItem(PROJECT_KEY)); } catch (_) { return null; }
}

$("#installerBtn")?.addEventListener("click", () => { location.href = "/installers.html"; });

// ---------- step progress (image & scan pages) ----------
// Each <li data-step> in #steps is done or not; the first one not done is the current step. Location is read
// straight from the latitude/longitude inputs.

const STEPS = {};

function markStep(key, done = true) {
  STEPS[key] = done;
  updateSteps();
}

function updateSteps() {
  const ol = $("#steps");
  if (!ol) return;
  STEPS.location = num("#lat") !== null && num("#lon") !== null;
  const items = [...ol.querySelectorAll("li[data-step]")];
  let current = null;
  for (const li of items) {
    const done = !!STEPS[li.dataset.step];
    li.classList.toggle("done", done);
    if (!done && !current) current = li;
  }
  for (const li of items) {
    li.classList.toggle("current", li === current);
    const a = li.querySelector("a");
    if (li === current) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
    const state = li.classList.contains("done") ? "done" : li === current ? "current step" : "to do";
    a.setAttribute("aria-label", `${li.querySelector(".step-label").textContent}: ${state}`);
  }
  ol.style.setProperty("--progress", items.filter((li) => li.classList.contains("done")).length / items.length);
}

for (const id of ["#lat", "#lon"]) $(id)?.addEventListener("input", updateSteps);
document.addEventListener("DOMContentLoaded", updateSteps);
updateSteps();

// ---------- custom range sliders: fill the track up to the thumb ----------

function paintRange(r) {
  const min = Number(r.min || 0), max = Number(r.max || 100);
  r.style.setProperty("--fill", `${((Number(r.value) - min) / (max - min)) * 100}%`);
}
for (const r of document.querySelectorAll('input[type="range"]')) {
  paintRange(r);
  r.addEventListener("input", () => paintRange(r));
}
