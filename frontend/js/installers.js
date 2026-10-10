"use strict";
// "Find solar installers near me" page. Needs common.js. Project summary comes from sessionStorage (set by
// showReport). The user's location (from the report, or the browser's geolocation) is sent to /api/installers,
// rounded to 2 decimals (~1 km), which returns installers nearest first. State / City lists come from
// /api/locations (all states and UTs of India). The search box filters the loaded results in the browser.

const project = loadProject();
let LOC = [];      // [{name, type, cities: [{name, lat, lon}]}] from /api/locations
let shown = [];    // last API result for the current filters
let total = 0;     // matches on the server (shown may be the first `limit` of them)
let here = null;   // { lat, lon, source }

const hasNum = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;

// ---------- summary ----------

function showSummary() {
  const back = $("#backLink");
  if (project?.from === "/image.html" || project?.from === "/scan.html") back.href = project.from;
  // Return to the report as it was (bfcache) when we came straight from it; otherwise open that page.
  back.addEventListener("click", (e) => {
    if (document.referrer && new URL(document.referrer).pathname === new URL(back.href).pathname) {
      e.preventDefault();
      history.back();
    }
  });

  if (project && hasNum(project.lat) && hasNum(project.lon)) {
    here = { lat: project.lat, lon: project.lon, source: "the location in your report" };
  }
  if (!project || !(project.capacity_kw > 0)) {
    $("#noProject").hidden = false;
    return;
  }
  $("#summary").hidden = false;
  countUp($("#sPanels"), project.panel_count);
  countUp($("#sKw"), project.capacity_kw, 2);
  countUp($("#sGross"), project.gross_cost_inr);
  countUp($("#sNet"), project.net_cost_inr);
  $("#fitWrap").hidden = false;
  $("#fitKw").textContent = fmt(project.capacity_kw, 2);
}

// ---------- location ----------

function showLocation() {
  const t = $("#locText");
  if (here) {
    t.textContent = `Showing installers nearest to ${fmt(here.lat, 4)}, ${fmt(here.lon, 4)} (${here.source}).`;
    $("#useLocBtn").innerHTML = "&#128205; Update to my current location";
    $("#useLocBtn").className = "secondary";
  } else {
    t.textContent = "Share your location to see the installers closest to you. Until then all installers are listed by name.";
  }
  updateRadius();
  $("#showAllBtn").hidden = !here;
  $("#listTitle").textContent = here ? "Installers near you" : "Installers";
}

// The distance limit is for "near me". Once a state is picked, show all of its matches (still nearest first).
function updateRadius() {
  const r = $("#radius");
  r.disabled = !here || !!$("#state").value;
  r.title = here && $("#state").value ? "Clear the State filter to limit by distance" : "";
}

function useMyLocation() {
  if (!navigator.geolocation) { setStatus("Location is not available in this browser. Use the State / City filters.", "error"); return; }
  const btn = $("#useLocBtn");
  btn.disabled = true;
  setStatus("Getting your location…", "busy");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      btn.disabled = false;
      here = { lat: p.coords.latitude, lon: p.coords.longitude, source: "your current location" };
      // A nearby search should not be narrowed by an old state/city choice.
      $("#state").value = "";
      fillCities();
      showLocation();
      refresh();
    },
    (e) => {
      btn.disabled = false;
      setStatus(`Could not get your location (${e.message}). Allow location access, or use the State / City filters.`, "error");
    },
    { timeout: 10000, maximumAge: 300000 },
  );
}

// ---------- data ----------

async function fetchInstallers(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined) qs.set(k, v);
  return fetchJson(`/api/installers${qs.toString() ? `?${qs}` : ""}`);
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (r.status === 404) {
    throw new Error("this server has no installer API yet. Restart it (Ctrl+C, then uvicorn backend.app:app --reload --port 8000) and reload the page.");
  }
  if (!r.ok) throw new Error(await apiError(r));
  return r.json();
}

// Fill the State dropdown with every state / UT. Retried by refresh() until it succeeds.
async function loadLocations() {
  const sel = $("#state");
  sel.disabled = $("#city").disabled = true;
  try {
    LOC = (await fetchJson("/api/locations")).states;
  } catch (e) {
    sel.options[0].text = $("#city").options[0].text = "Not available";
    setStatus(`Could not load the list of states: ${e.message}`, "error");
    return false;
  }
  sel.innerHTML = "";
  sel.add(new Option("All states and UTs", ""));
  for (const [type, label] of [["state", "States"], ["union_territory", "Union territories"]]) {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const st of LOC.filter((x) => x.type === type)) g.append(new Option(st.name, st.name));
    sel.append(g);
  }
  sel.disabled = false;
  fillCities();
  return true;
}

// City dropdown: every city of the chosen state.
function fillCities() {
  const sel = $("#city");
  const st = LOC.find((x) => x.name === $("#state").value);
  sel.innerHTML = "";
  sel.add(new Option(st ? `All cities in ${st.name}` : "Choose a state first", ""));
  for (const c of st ? st.cities : []) sel.add(new Option(c.name, c.name));
  sel.disabled = !st;
}

const selectedCity = () => LOC.find((x) => x.name === $("#state").value)?.cities.find((c) => c.name === $("#city").value);

async function refresh() {
  if (!LOC.length && !(await loadLocations())) return;
  const params = { state: $("#state").value, city: $("#city").value };
  if (project?.capacity_kw > 0 && $("#fitSize").checked) {
    params.min_kwp = project.capacity_kw;
    params.max_kwp = project.capacity_kw;
  }
  // Sort by distance from the user; without a user location, from the chosen city's centre.
  const origin = here || selectedCity();
  if (origin) {
    params.lat = round2(origin.lat);
    params.lon = round2(origin.lon);
    if (here && !params.state) params.radius_km = $("#radius").value;
  }
  setStatus("Loading installers…", "busy");
  showSkeletons();
  try {
    const j = await fetchInstallers(params);
    shown = j.installers;
    total = j.total ?? j.count;
    if (j.note) { $("#dataNote").hidden = false; $("#dataNote").textContent = j.note; }
    render();
  } catch (e) {
    shown = [];
    $("#list").innerHTML = "";
    $("#empty").hidden = true;
    setStatus(`Could not load installers: ${e.message}`, "error");
  }
}

// ---------- cards ----------

// Placeholder cards while a request runs.
function showSkeletons(n = 4) {
  const list = $("#list");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const li = document.createElement("li");
    li.className = "skeleton";
    li.setAttribute("aria-hidden", "true");
    li.innerHTML = "<i></i><i></i><i></i><i></i>";
    list.append(li);
  }
  $("#empty").hidden = true;
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c);
  return n;
}

// Address as published, completed with city / state / PIN when the source left them out. Null if unpublished.
function fullAddress(e) {
  if (!e.address) return null;
  const low = e.address.toLowerCase();
  const extra = [e.city, e.state].filter((x) => x && !low.includes(x.toLowerCase()));
  if (e.pincode && !e.address.replace(/\s/g, "").includes(e.pincode)) extra.push(e.pincode);
  return [e.address, ...extra].join(", ");
}
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (_) { return null; } };

// WhatsApp only for Indian mobile numbers: 10 digits starting 6-9, bare or written with +91. A leading 0 is not
// accepted: "0755 2551234" is a Bhopal landline (STD code 0755), not a mobile.
function whatsappNumber(phone) {
  const d = String(phone || "").replace(/\D/g, "").replace(/^91(?=[6-9]\d{9}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null;
}

const prettyPhone = (p) => (/^[6-9]\d{9}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : p);

function enquiryText() {
  if (!(project?.capacity_kw > 0)) return "Hello, I would like a quote for a rooftop solar system for my home.";
  return `Hello, I would like a quote for a rooftop solar system of about ${fmt(project.capacity_kw, 2)} kWp `
    + `(${fmt(project.panel_count)} panels), estimated with SolarScope. Please let me know a convenient time for a site visit.`;
}

// A <dt>/<dd> pair, or nothing when the source did not publish the value.
function field(label, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return [];
  return [el("dt", {}, label), el("dd", {}, value)];
}

function card(e) {
  const name = e.company_name;
  const addr = fullAddress(e);
  const wa = whatsappNumber(e.phone);
  const web = safeUrl(e.website);
  const ext = { target: "_blank", rel: "noopener noreferrer" };
  const chips = (xs) => (xs?.length ? el("ul", { class: "chips" }, ...xs.map((x) => el("li", {}, x))) : null);
  const exact = e.location_precision !== "region";
  const dist = hasNum(e.distance_km)
    ? el("span", { class: "dist", title: exact ? "Straight-line distance to the centre of the office's town" : "Office town not published; distance to the area it is registered for" },
      // Offices sit at their town centre, so short distances are not meaningful to the kilometre.
      e.distance_km < 5 ? `Under 5 km${exact ? " away" : " (approx.)"}` : `≈ ${fmt(e.distance_km)} km${exact ? " away" : " (approx.)"}`)
    : null;
  const sizes = hasNum(e.min_kwp) && hasNum(e.max_kwp) ? `${fmt(e.min_kwp, 1)} – ${fmt(e.max_kwp, 1)} kWp` : null;
  const src = e.source?.url && safeUrl(e.source.url)
    ? el("p", { class: "muted small inst-source" }, "Source: ",
      el("a", { href: safeUrl(e.source.url), ...ext }, e.source.name || "official list"),
      e.source.retrieved ? `, checked ${e.source.retrieved}` : "")
    : null;

  return el("li", { class: "inst-card" },
    el("article", { "aria-labelledby": `n-${e.id}` },
      el("div", { class: "inst-head" }, el("h3", { id: `n-${e.id}` }, name), dist),
      e.contact_person ? el("p", { class: "muted small" }, `Contact: ${e.contact_person}`) : null,
      el("div", { class: "inst-contact", role: "group", "aria-label": `Contact ${name}` },
        e.phone ? el("a", { class: "call", href: `tel:${e.phone.replace(/[^\d+]/g, "")}`, "aria-label": `Call ${name} on ${e.phone}` },
          "📞 Call ", el("span", {}, prettyPhone(e.phone))) : null,
        wa ? el("a", { href: `https://wa.me/${wa}?text=${encodeURIComponent(enquiryText())}`, ...ext,
          "aria-label": `WhatsApp ${name} (opens WhatsApp)` }, "💬 WhatsApp") : null,
        e.email ? el("a", { href: `mailto:${e.email}?subject=${encodeURIComponent("Rooftop solar quote request")}&body=${encodeURIComponent(enquiryText())}`,
          "aria-label": `Email ${name} at ${e.email}` }, "✉ Email") : null,
        addr ? el("a", { href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`, ...ext,
          "aria-label": `Directions to ${name} (opens Google Maps)` }, "🧭 Directions") : null,
        web ? el("a", { href: web, ...ext, "aria-label": `${name} website (opens in a new tab)` }, "🌐 Website") : null,
      ),
      el("dl", {},
        ...field("Phone", e.phone && prettyPhone(e.phone)),
        ...field("Email", e.email),
        ...field("Address", addr || "Not published in the official list"),
        ...field("Registered for", e.service_areas.join(", ")),
        ...field("Services", chips(e.services)),
        ...field("Experience", hasNum(e.years_experience) ? `${fmt(e.years_experience)} years` : null),
        ...field("Empanelment", chips(e.certifications)),
        ...field("System sizes", sizes),
      ),
      src,
    ),
  );
}

function render() {
  const q = $("#q").value.trim().toLowerCase();
  const hay = (e) => [e.company_name, e.contact_person, e.city, e.state, e.pincode, e.address,
    ...e.service_areas, ...e.services, ...e.certifications].filter(Boolean).join(" ").toLowerCase();
  const items = q ? shown.filter((e) => q.split(/\s+/).every((w) => hay(e).includes(w))) : shown;

  const list = $("#list");
  list.innerHTML = "";
  list.setAttribute("aria-busy", "false");
  for (const e of items) list.append(card(e));
  $("#empty").hidden = items.length > 0;
  const st = $("#state").value, city = $("#city").value, r = $("#radius").value;
  const where = city ? ` in ${city}` : st ? ` in ${st}` : here && r ? ` within ${r} km` : "";
  const order = here || city ? ", nearest first" : "";
  const n = (k) => (k === 1 ? "1 installer" : `${fmt(k)} installers`);
  let msg = q ? `${n(items.length)} matching "${$("#q").value.trim()}"${where}`
    : total > shown.length ? `Showing the first ${fmt(shown.length)} of ${n(total)}${where}${order}`
      : `${n(items.length)}${where}${order}`;
  if (!here && !st && total > shown.length) msg += ". Choose your state or use your location to see installers near you.";
  setStatus(msg);
}

// ---------- init ----------

showSummary();
showLocation();
$("#useLocBtn").addEventListener("click", useMyLocation);
$("#radius").addEventListener("change", refresh);
$("#state").addEventListener("change", () => { fillCities(); updateRadius(); refresh(); });
$("#city").addEventListener("change", refresh);
$("#fitSize").addEventListener("change", refresh);
$("#q").addEventListener("input", render);
$("#filters").addEventListener("reset", () => setTimeout(() => { fillCities(); updateRadius(); refresh(); }));
$("#showAllBtn").addEventListener("click", () => {
  $("#radius").value = "";
  $("#filters").reset();  // the reset handler refreshes
});

refresh();
