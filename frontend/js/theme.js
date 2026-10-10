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
    root.setAttribute("data-theme", theme);
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
