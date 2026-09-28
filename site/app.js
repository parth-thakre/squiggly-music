// Squiggly's site. Fills the download links from the latest GitHub release (the only request
// this page makes). Every loop on the page is a CSS animation; this script only schedules
// the lyric fill once, restarts it each cycle, ticks the deck's clock once a second, and
// pauses what's offscreen. Nothing here runs per frame, and nothing listens to scroll.
(function () {
  "use strict";

  var doc = document;
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Downloads ---------- */

  var API = "https://api.github.com/repos/parth-thakre/squiggly-music/releases/latest";
  var PATTERNS = {
    setup: /-windows-x64-setup\.exe$/i,
    portable: /-windows-x64-portable\.exe$/i,
    rpm: /\.x86_64\.rpm$/i,
    sums: /^SHA256SUMS$/
  };

  function platform() {
    var ua = navigator.userAgent || "";
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/win/i.test(p) || /Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(p + ua) && !/Android/i.test(ua)) return "linux";
    return "other";
  }

  var pills = doc.querySelectorAll("[data-pill]");
  function pillsFor(key, label) {
    for (var i = 0; i < pills.length; i++) {
      pills[i].textContent = label;
      pills[i].setAttribute("data-asset", key);
    }
  }
  if (platform() === "linux") pillsFor("rpm", "Download for Fedora");
  else pillsFor("setup", "Download for Windows");

  function setText(selector, text) {
    var nodes = doc.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }

  function fill(release) {
    var assets = release.assets || [];
    var version = String(release.tag_name || release.name || "").replace(/^v/, "");
    if (version) setText("[data-version]", version);
    Object.keys(PATTERNS).forEach(function (key) {
      var asset = null;
      for (var i = 0; i < assets.length; i++) if (PATTERNS[key].test(assets[i].name)) { asset = assets[i]; break; }
      if (!asset) return;
      var links = doc.querySelectorAll('[data-asset="' + key + '"]');
      for (var j = 0; j < links.length; j++) links[j].href = asset.browser_download_url;
    });
  }

  if (typeof fetch === "function") {
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) { if (release) fill(release); })
      .catch(function () { /* the links already point at the release page */ });
  }

  /* ---------- Pausing what's offscreen ---------- */

  // Each [data-pause] block gets .away while out of view, which pauses its CSS animations.
  var wake = new WeakMap();
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        e.target.classList.toggle("away", !e.isIntersecting);
        var fn = wake.get(e.target);
        if (fn && e.isIntersecting) fn();
      });
    }, { threshold: 0 });
    doc.querySelectorAll("[data-pause]").forEach(function (el) { io.observe(el); });
  }

  /* ---------- Lyrics, word by word ---------- */

  // Each word's fill is a CSS animation of --p, scheduled once from the word's length. The
  // cycle restarts by re-adding the class. Without this script, or with reduced motion, the
  // words sit at --p: 1, sung.
  var sing = doc.querySelector("[data-sing]");
  if (sing) {
    var at = 900;
    sing.querySelectorAll(".sing-line").forEach(function (line) {
      line.querySelectorAll(".w").forEach(function (w) {
        var ms = 130 + 46 * w.textContent.length;
        w.style.setProperty("--d", at + "ms");
        w.style.setProperty("--t", ms + "ms");
        at += ms;
      });
      at += 380;
    });
    var cycle = at + 1700, timer = 0;
    function restart() {
      sing.classList.remove("go");
      void sing.offsetWidth;
      sing.classList.add("go");
    }
    function run() {
      clearInterval(timer);
      if (reduced.matches || doc.hidden) { sing.classList.remove("go"); return; }
      restart();
      timer = setInterval(restart, cycle);
    }
    wake.set(sing, run);
    doc.addEventListener("visibilitychange", run);
    reduced.addEventListener("change", run);
    run();
  }

  /* ---------- The deck's clock ---------- */

  // The playhead is a CSS animation; the clock reads its time once a second, so a pause
  // offscreen keeps them together.
  var strip = doc.querySelector(".deck .strip");
  var clock = doc.querySelector("[data-clock]");
  if (strip && clock && strip.getAnimations) {
    setInterval(function () {
      var a = strip.getAnimations()[0];
      if (!a || a.currentTime == null) return;
      var s = 5 + Math.floor(a.currentTime / 1000) % 228;
      var text = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      if (clock.textContent !== text) clock.textContent = text;
    }, 1000);
  }
})();
