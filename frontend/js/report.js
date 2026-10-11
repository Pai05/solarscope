"use strict";
// Downloadable report and recent-report history (image and scan pages). Needs common.js.
// A report is one self-contained HTML file (plan image inlined) that opens anywhere and prints to PDF.
// The last HISTORY_MAX reports are kept in this browser's localStorage, so they survive closing the tab.

const HISTORY_KEY = "solarscope.history";
const HISTORY_MAX = 4;
let lastReport = null;  // data of the report on screen, for the download / print buttons

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Image of the plan / roof with panels, on white, as JPEG data URL (pages provide window.SolarScopeReportImage).
function reportImage() {
  try {
    const src = window.SolarScopeReportImage?.();
    if (!src || !src.width || !src.height) return null;
    const k = Math.min(1, 1000 / src.width);
    const c = document.createElement("canvas");
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } catch (_) {
    return null;  // e.g. a tainted canvas: the report still works without the picture
  }
}

function reportData(rep) {
  const s = reportSettings();
  return {
    id: Date.now(),
    time: new Date().toISOString(),
    page: location.pathname.includes("scan") ? "Phone scan" : "Image",
    lat: s.lat, lon: s.lon, setback_m: s.setback_m,
    image: reportImage(),
    rep: {
      panel_count: rep.panel_count, capacity_kw: rep.capacity_kw,
      annual_generation_kwh: rep.annual_generation_kwh, annual_savings_inr: rep.annual_savings_inr,
      payback_years: rep.payback_years, gross_cost_inr: rep.gross_cost_inr, subsidy_inr: rep.subsidy_inr,
      net_cost_inr: rep.net_cost_inr, co2_avoided_kg_per_year: rep.co2_avoided_kg_per_year,
      specific_yield_kwh_per_kwp: rep.specific_yield_kwh_per_kwp, areas_m2: rep.areas_m2,
      panel_types: rep.panel_types || [], min_panel_size_m: rep.min_panel_size_m || null,
      panel_orientation: rep.panel_orientation, assumptions: rep.assumptions || {},
      budget: rep.budget ? { ...rep.budget, spare_panels: [], spare_small_panels: [] } : null,
    },
  };
}

const when = (iso) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

function reportHTML(d) {
  const r = d.rep, a = r.areas_m2 || {};
  const row = (k, v) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`;
  const types = r.panel_types.filter((t) => t.count > 0 || t.name === "Standard");
  const small = r.panel_types.find((t) => t.name !== "Standard" && t.count > 0);
  const m = r.min_panel_size_m;
  const kpi = (v, label) => `<div class="k"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SolarScope report ${esc(when(d.time))}</title>
<style>
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0a1633; background: #fff; margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px 40px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 10px; border-bottom: 2px solid #ffa600; padding-bottom: 4px; }
  .meta { color: #4b5878; margin: 0 0 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .k { border: 1px solid #d6deee; border-radius: 10px; padding: 10px 12px; } .k b { display: block; font-size: 22px; } .k span { color: #4b5878; font-size: 13px; }
  img { width: 100%; border: 1px solid #d6deee; border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 7px 10px; border-bottom: 1px solid #e2e9f6; text-align: left; vertical-align: top; }
  th { background: #eef3fb; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #4b5878; }
  .n { text-align: right; font-weight: 700; white-space: nowrap; } tr.total td { font-weight: 800; background: #eef3fb; }
  .note { color: #4b5878; font-size: 13px; }
  .budget { margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; background: #dcf7ea; color: #0b5c3e; } .small td { font-size: 13px; }
  @media print { main { padding: 0; } h2 { break-after: avoid; } img, table, .kpis { break-inside: avoid; } }
</style></head><body><main>
<h1>☀ SolarScope rooftop solar report</h1>
<p class="meta">${esc(when(d.time))} · from ${esc(d.page)}${Number.isFinite(d.lat) && Number.isFinite(d.lon) ? ` · location ${esc(fmt(d.lat, 4))}, ${esc(fmt(d.lon, 4))}` : ""}</p>
<div class="kpis">
  ${kpi(fmt(r.panel_count), "panels that fit")}${kpi(`${fmt(r.capacity_kw, 2)} kWp`, "system size")}
  ${kpi(`${fmt(r.annual_generation_kwh)} kWh`, "per year")}${kpi(`₹ ${fmt(r.annual_savings_inr)}`, "saved per year")}
  ${kpi(`₹ ${fmt(r.net_cost_inr)}`, "cost after subsidy")}${kpi(r.payback_years == null ? "–" : `${fmt(r.payback_years, 1)} yrs`, "payback")}
</div>
${budgetSummary(r) ? `<p class="budget"><b>${r.budget.limited ? "Sized to your budget" : "Within your budget"}:</b> ${esc(budgetSummary(r))}</p>` : ""}
${d.image ? `<h2>Roof plan with panels</h2><img src="${d.image}" alt="Roof plan with the solar panels laid out">` : ""}
<h2>Panels</h2>
<table><thead><tr><th>Type</th><th>Size (m)</th><th class="n">Power</th><th class="n">Count</th></tr></thead><tbody>
${types.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(fmt(t.w_m, 2))} × ${esc(fmt(t.h_m, 2))}</td><td class="n">${esc(fmt(t.wp))} Wp</td><td class="n">${esc(fmt(t.count))}</td></tr>`).join("")}
<tr class="total"><td>Total</td><td></td><td class="n">${esc(fmt(r.capacity_kw, 2))} kWp</td><td class="n">${esc(fmt(r.panel_count))}</td></tr>
</tbody></table>
${m ? `<p class="note">Minimum panel size in this layout: ${esc(fmt(Math.max(m.w, m.h), 2))} m × ${esc(fmt(Math.min(m.w, m.h), 2))} m, with a ${esc(fmt(d.setback_m, 2))} m edge gap.${small ? " Small panels work at a different voltage: wire them on a separate string / inverter input, or use microinverters." : ""}</p>` : ""}
<h2>Roof</h2>
<table><tbody>
${row("Roof area (incl. obstructions)", `${fmt(a.roof_total, 1)} m²`)}${row("Obstructions", `${fmt(a.obstructions, 1)} m²`)}
${row("Usable after setbacks", `${fmt(a.usable_after_setback, 1)} m²`)}${row("Covered by panels", `${fmt(a.covered_by_panels, 1)} m²`)}
${row("Specific yield", `${fmt(r.specific_yield_kwh_per_kwp)} kWh/kWp/yr`)}${row("CO₂ avoided", `${fmt((r.co2_avoided_kg_per_year || 0) / 1000, 2)} t per year`)}
</tbody></table>
<h2>Cost</h2>
<table><tbody>
${row("System cost", `₹ ${fmt(r.gross_cost_inr)}`)}${row("Subsidy (PM Surya Ghar)", `− ₹ ${fmt(r.subsidy_inr)}`)}
${row("Net cost", `₹ ${fmt(r.net_cost_inr)}`)}${row("Savings per year", `₹ ${fmt(r.annual_savings_inr)}`)}
</tbody></table>
<h2>Assumptions and sources</h2>
<table class="small"><thead><tr><th>Input</th><th>Value</th><th>Source</th></tr></thead><tbody>
${Object.entries(r.assumptions).map(([k, x]) => `<tr><td>${esc((typeof LABELS !== "undefined" && LABELS[k]) || k)}</td><td>${esc(typeof x.value === "number" ? fmt(x.value, x.value < 10 ? 3 : 0) : x.value)} ${esc(x.unit)}</td><td>${esc(x.source)}${x.verified ? "" : " (not yet verified)"}</td></tr>`).join("")}
</tbody></table>
<p class="note">Estimate only: confirm the layout, panel datasheets and prices with a site survey and written quotes from installers.</p>
</main></body></html>`;
}

const fileName = (d) => `SolarScope-report-${d.time.slice(0, 16).replace(/[:T]/g, "-")}.html`;

function downloadReport(d) {
  const url = URL.createObjectURL(new Blob([reportHTML(d)], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(d);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function openReport(d, print = false) {
  const w = window.open("", "_blank");
  if (!w) { downloadReport(d); return; }  // pop-up blocked: give the file instead
  w.document.open();
  w.document.write(reportHTML(d));
  w.document.close();
  if (print) w.addEventListener("load", () => w.print(), { once: true });
  if (print && w.document.readyState === "complete") w.print();
}

// ---------- history ----------

function loadHistory() {
  try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY)); return Array.isArray(h) ? h : []; } catch (_) { return []; }
}

function saveHistory(list) {
  for (let keep = list.length; keep >= 0; keep--) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, keep))); return; }
    catch (_) { /* storage full or blocked: retry with fewer entries */ }
  }
}

function renderHistory() {
  const box = $("#history"), ul = $("#historyList");
  if (!box || !ul) return;
  const list = loadHistory();
  box.hidden = list.length === 0;
  ul.innerHTML = "";
  for (const d of list) {
    const li = document.createElement("li");
    li.className = "history-item";
    if (d.image) {
      const img = document.createElement("img");
      img.src = d.image;
      img.alt = "";
      li.append(img);
    }
    const info = document.createElement("div");
    info.className = "history-info";
    const t = document.createElement("strong");
    t.textContent = `${fmt(d.rep.panel_count)} panels · ${fmt(d.rep.capacity_kw, 2)} kWp`;
    const sub = document.createElement("span");
    sub.className = "muted small";
    sub.textContent = `${when(d.time)} · ${d.page} · ${fmt(d.rep.areas_m2?.roof_total, 1)} m² roof · ₹ ${fmt(d.rep.net_cost_inr)} after subsidy`;
    info.append(t, sub);
    const act = document.createElement("div");
    act.className = "history-actions";
    const mk = (label, cls, fn, aria) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      b.addEventListener("click", fn);
      return b;
    };
    act.append(
      mk("View", "secondary small-btn", () => openReport(d), `View report from ${when(d.time)}`),
      mk("⬇ Download", "secondary small-btn", () => downloadReport(d), `Download report from ${when(d.time)}`),
      mk("✕", "secondary small-btn icon", () => { saveHistory(loadHistory().filter((x) => x.id !== d.id)); renderHistory(); },
        `Remove report from ${when(d.time)}`),
    );
    li.append(info, act);
    ul.append(li);
  }
}

// Called by showReport (common.js) once a report is on screen.
function onReportReady(rep) {
  lastReport = reportData(rep);
  saveHistory([lastReport, ...loadHistory()].slice(0, HISTORY_MAX));
  renderHistory();
  for (const id of ["#downloadReport", "#printReport"]) { const b = $(id); if (b) b.disabled = false; }
  // Let other widgets (the help chat) follow up on the new report.
  document.dispatchEvent(new CustomEvent("solarscope:report", { detail: { rep, budgetText: budgetSummary(rep) } }));
}

$("#downloadReport")?.addEventListener("click", () => lastReport && downloadReport(lastReport));
$("#printReport")?.addEventListener("click", () => lastReport && openReport(lastReport, true));
$("#clearHistory")?.addEventListener("click", () => { saveHistory([]); renderHistory(); });
renderHistory();
