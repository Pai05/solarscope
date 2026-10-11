// Opening the website always starts on the home page. Image / Phone scan / Installers stay open only when reached
// by a link inside SolarScope (or Back/Forward between its pages). Typing or tapping the address, a bookmark, a
// shared link, a reload, or the phone restoring an old tab goes home - as does coming back to the tab after
// AWAY_MS in the background. Runs first, in <head>, so the inner page never flashes.
(function () {
  "use strict";
  if (!/^https?:$/.test(location.protocol)) return;
  var AWAY_MS = 10 * 60 * 1000;
  var KEY = "solarscope.hiddenAt";
  var home = location.pathname === "/" || /\/index\.html$/.test(location.pathname);
  var goHome = function () { location.replace("/"); };  // replace: Back does not return to the left page
  var get = function () { try { return Number(sessionStorage.getItem(KEY)) || 0; } catch (e) { return 0; } };
  var set = function (v) { try { if (v) sessionStorage.setItem(KEY, String(v)); else sessionStorage.removeItem(KEY); } catch (e) { /* blocked */ } };
  var awayTooLong = function () { var t = get(); return t > 0 && Date.now() - t > AWAY_MS; };

  if (!home) {
    var nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || null;
    var type = nav ? nav.type : "navigate";
    var fromSite = document.referrer.indexOf(location.origin + "/") === 0;
    if (!fromSite || (type !== "navigate" && type !== "back_forward") || awayTooLong()) {
      set(0);
      goHome();
      return;
    }
  }
  set(0);
  // Back in the tab after a long time away (phone app switch, screen off): start again from home.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { set(Date.now()); return; }
    if (!home && awayTooLong()) { set(0); goHome(); return; }
    set(0);
  });
  window.addEventListener("pageshow", function (e) {  // page restored from the back/forward cache
    if (e.persisted && !home && awayTooLong()) { set(0); goHome(); }
  });
})();

// Light / dark theme. Loaded in <head> (not deferred) so the saved choice applies before the first paint.
// Without a saved choice the page follows the system setting, also when it changes.
(function () {
  "use strict";
  var KEY = "solarscope.theme";
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { var v = localStorage.getItem(KEY); return v === "dark" || v === "light" ? v : null; } catch (e) { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }
  function current() { return saved() || (mq && mq.matches ? "dark" : "light"); }

  function apply(theme) {
    var changed = root.getAttribute("data-theme") !== theme;
    root.setAttribute("data-theme", theme);
    // Canvases (roof plan) read theme colours when they draw: tell them to redraw.
    if (changed) document.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#060c1d" : "#0b1a3d");
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var next = theme === "dark" ? "light" : "dark";
      buttons[i].setAttribute("aria-label", "Switch to " + next + " mode");
      buttons[i].setAttribute("title", "Switch to " + next + " mode");
      buttons[i].setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    }
  }

  apply(current());
  if (mq) {
    var follow = function () { if (!saved()) apply(current()); };
    if (mq.addEventListener) mq.addEventListener("change", follow); else if (mq.addListener) mq.addListener(follow);
  }

  document.addEventListener("DOMContentLoaded", function () {
    apply(current());
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        save(next);
        apply(next);
      });
    }

    // Sticky header height -> --header-h, so the desktop input column and anchors sit below it.
    var header = document.querySelector(".site-header");
    if (header) {
      var setH = function () { root.style.setProperty("--header-h", header.offsetHeight + "px"); };
      setH();
      if (window.ResizeObserver) new ResizeObserver(setH).observe(header); else window.addEventListener("resize", setH);
    }
  });
})();
