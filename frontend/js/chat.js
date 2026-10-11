"use strict";
// Help chat widget on every page: a floating "Help" button that opens a chat about using SolarScope.
// Answers come from /api/chat (built-in guide, or Claude when the server has an API key). Self-contained: needs
// no other script. The conversation is kept in sessionStorage, so it follows the user from page to page.
(function () {
  const KEY = "solarscope.chat";
  const PAGE = /scan/.test(location.pathname) ? "scan" : /image/.test(location.pathname) ? "image"
    : /installers/.test(location.pathname) ? "installers" : "home";
  const WELCOME = "Hi! I'm the SolarScope helper. Ask me anything about using this website, for example how to use the "
    + "AR scan, add obstructions, set your location, read the report or find installers.";

  let log = [];  // [{role: "user"|"assistant", text, suggestions?}]
  try { log = JSON.parse(sessionStorage.getItem(KEY)) || []; } catch (_) { log = []; }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(log.slice(-30))); } catch (_) { /* blocked */ } };

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  };

  // Answer text -> DOM: "1. " lines become an ordered list, **x** bold, other lines paragraphs. Built with
  // text nodes only (never innerHTML), so nothing in an answer can inject markup.
  function rich(text) {
    const box = h("div", { class: "chat-text" });
    let list = null;
    const inline = (line) => {
      const frag = document.createDocumentFragment();
      line.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(h("strong", {}, part.slice(2, -2)));
        else if (part) frag.append(part);
      });
      return frag;
    };
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) { list = null; continue; }
      const m = line.match(/^(\d+)[.)]\s+(.*)$/) || line.match(/^[-•]\s+(.*)$/);
      if (m) {
        if (!list) { list = h("ol"); box.append(list); }
        list.append(h("li", {}, inline(m[m.length - 1])));
      } else {
        list = null;
        box.append(h("p", {}, inline(line)));
      }
    }
    return box;
  }

  // ---------- DOM ----------
  const fab = h("button", { class: "chat-fab", type: "button", "aria-label": "Open SolarScope help chat", "aria-expanded": "false" },
    h("span", { "aria-hidden": "true" }, "💬"), h("span", { class: "chat-fab-label" }, "Help"));
  const msgs = h("div", { class: "chat-msgs", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
  const chips = h("div", { class: "chat-chips", "aria-label": "Suggested questions" });
  const input = h("input", { class: "chat-input", type: "text", maxlength: "500", placeholder: "Ask how to use SolarScope…",
    "aria-label": "Your question", autocomplete: "off" });
  const send = h("button", { class: "chat-send", type: "submit", "aria-label": "Send" }, "➤");
  const form = h("form", { class: "chat-form" }, input, send);
  const panel = h("section", { class: "chat-panel", role: "dialog", "aria-label": "SolarScope help", hidden: "" },
    h("header", { class: "chat-head" },
      h("div", {}, h("strong", {}, "SolarScope help"), h("span", { class: "chat-sub" }, "Answers about using this website")),
      h("button", { class: "chat-clear", type: "button", title: "Start a new conversation", onclick: reset }, "New"),
      h("button", { class: "chat-close", type: "button", "aria-label": "Close help", onclick: () => toggle(false) }, "✕")),
    msgs, chips, form);
  document.body.append(fab, panel);
  // Keep the button clear of the sticky "compute report" bar / editor toolbar at the bottom on phones.
  if (document.querySelector(".action-bar, .editor-toolbar")) fab.classList.add("raised");

  function bubble(entry) {
    const el = h("div", { class: `chat-msg ${entry.role}` });
    el.append(entry.role === "assistant" ? rich(entry.text) : h("p", {}, entry.text));
    return el;
  }

  function setChips(list) {
    chips.replaceChildren(...(list || []).map((q) => h("button", { type: "button", class: "chat-chip", onclick: () => ask(q) }, q)));
  }

  function render() {
    msgs.replaceChildren(bubble({ role: "assistant", text: WELCOME }), ...log.map(bubble));
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function loadStarters() {
    try {
      const r = await fetch(`/api/chat/starters?page=${PAGE}`);
      if (r.ok) setChips((await r.json()).questions);
    } catch (_) { /* offline: no chips */ }
  }

  function reset() {
    log = [];
    save();
    render();
    loadStarters();
    input.focus();
  }

  function toggle(open) {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    fab.hidden = open;
    if (open) {
      render();
      const last = log[log.length - 1];
      if (last?.suggestions?.length) setChips(last.suggestions); else loadStarters();
      setTimeout(() => input.focus(), 50);
    } else {
      fab.focus();
    }
  }

  let busy = false;
  async function ask(text) {
    const q = (text || "").trim().slice(0, 500);
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    const history = log.slice(-6).map(({ role, text: t }) => ({ role, text: t.slice(0, 2000) }));
    log.push({ role: "user", text: q });
    input.value = "";
    render();
    setChips([]);
    const typing = h("div", { class: "chat-msg assistant typing", "aria-label": "Typing" }, h("span"), h("span"), h("span"));
    msgs.append(typing);
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, page: PAGE, history }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      log.push({ role: "assistant", text: j.answer, suggestions: j.suggestions });
      setChips(j.suggestions);
      if (j.action?.type === "set_budget") setTimeout(() => applyBudget(j.action), 0);
    } catch (_) {
      log.push({ role: "assistant", text: "Sorry, I couldn't reach the server. Check your connection and try again." });
    }
    save();
    render();
    busy = false;
    send.disabled = false;
    input.focus();
  }

  // ---------- budget from the chat ("I have only 1 lakh") ----------
  const PENDING = "solarscope.pendingBudget";
  const say = (text) => { log.push({ role: "assistant", text }); save(); if (!panel.hidden) render(); };

  // Fill the Budget box; recompute when a roof is ready, else keep it for the next report.
  function applyBudget({ amount, basis }) {
    const field = document.getElementById("budget");
    if (!field) {  // home / installers page: fill it in when a planning page opens
      try { sessionStorage.setItem(PENDING, JSON.stringify({ amount, basis })); } catch (_) { /* blocked */ }
      return;
    }
    field.value = String(amount);
    const sel = document.getElementById("budgetBasis");
    if (sel) sel.value = basis;
    field.dispatchEvent(new Event("input", { bubbles: true }));  // marks an old report as out of date
    sel?.dispatchEvent(new Event("change", { bubbles: true }));
    const btn = document.getElementById("reportBtn");
    if (btn && !btn.disabled) {
      document.addEventListener("solarscope:report", (e) => {
        const r = e.detail.rep;
        say((e.detail.budgetText || `Done: ${r.panel_count} panels, ${r.capacity_kw} kWp.`)
          + " The report and plan above are updated; you can **⬇ Download report** now.");
      }, { once: true });
      btn.click();
    } else {
      say("Your budget is filled in. Now measure your roof (**Start AR scan** or **Draw roof from size**, or upload an "
        + "image), then press compute: the plan will fit your budget.");
    }
  }

  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING));
    if (pending && document.getElementById("budget")) {
      sessionStorage.removeItem(PENDING);
      applyBudget(pending);
    }
  } catch (_) { /* nothing pending */ }

  fab.addEventListener("click", () => toggle(true));
  form.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) toggle(false); });
})();
