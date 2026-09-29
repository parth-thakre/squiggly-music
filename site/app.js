// Squiggly's site. Fills the download links from the latest GitHub release (the only request
// this page makes) and puts the visitor's platform first.
(function () {
  "use strict";

  var doc = document;

  /* ---------- Downloads ---------- */

  var API = "https://api.github.com/repos/parth-thakre/squiggly-music/releases/latest";
  var PATTERNS = {
    setup: /-windows-x64-setup\.exe$/i,
    portable: /-windows-x64-portable\.exe$/i,
    rpm: /\.x86_64\.rpm$/i,
    apk: /-android\.apk$/i,
    macArm: /-macos-arm64\.zip$/i,
    macIntel: /-macos-x64\.zip$/i,
    sums: /^SHA256SUMS$/
  };

  function platform() {
    var ua = navigator.userAgent || "";
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android/i.test(p + ua)) return "android";
    // iPads in desktop mode say they are Macs, but have a touch screen.
    if (/iPhone|iPad|iPod/i.test(p + ua)) return "other";
    if (/Mac/i.test(p) || /Macintosh/i.test(ua)) return (navigator.maxTouchPoints || 0) > 1 ? "other" : "mac";
    if (/win/i.test(p) || /Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(p + ua)) return "linux";
    return "other";
  }

  // The visitor's system gets the one filled button, and its files lead the list. The other
  // systems follow as a quiet "Also for" line. Anything without a build (an iPhone, an iPad)
  // gets Windows, the page's own first choice.
  var os = platform();
  doc.querySelectorAll("[data-cta]").forEach(function (cta) {
    var mine = cta.querySelector('[data-os="' + os + '"]') || cta.querySelector(".btn");
    var also = doc.createElement("span");
    also.className = "also";
    also.textContent = "Also for";
    cta.querySelectorAll(".btn").forEach(function (btn) {
      btn.classList.toggle("primary", btn === mine);
      if (btn !== mine) { btn.textContent = btn.getAttribute("data-name"); also.appendChild(btn); }
    });
    cta.insertBefore(mine, cta.firstChild);
    cta.appendChild(also);
    cta.classList.add("picked");
  });
  if (os !== "other") {
    doc.querySelectorAll(".files").forEach(function (list) {
      var rows = list.querySelectorAll('[data-os="' + os + '"]');
      for (var i = rows.length - 1; i >= 0; i--) list.insertBefore(rows[i], list.firstChild);
    });
  }

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
      var file = doc.querySelector('[data-file="' + key + '"]');
      if (file) file.textContent = asset.name + (asset.size > 1000000 ? ", " + Math.round(asset.size / 1000000) + " MB" : "");
    });
  }

  // Each Mac zip runs on one CPU, so a Mac's button only points at a zip once the CPU is known.
  // Chromium browsers can say whether it's Apple silicon or Intel. Safari and Firefox can't (every
  // Mac's user agent says Intel), and a browser may refuse or leave the answer empty; then the
  // button becomes two, one for each CPU. Elsewhere "Also for macOS" keeps the release page.
  function macChip() {
    var data = navigator.userAgentData;
    if (!data || typeof data.getHighEntropyValues !== "function") return Promise.resolve("");
    return Promise.resolve()
      .then(function () { return data.getHighEntropyValues(["architecture"]); })
      .then(function (values) {
        var arch = values && values.architecture;
        return arch === "arm" ? "macArm" : arch === "x86" ? "macIntel" : "";
      }, function () { return ""; });
  }

  function macButtons(chip) {
    doc.querySelectorAll('.btn.primary[data-os="mac"]').forEach(function (btn) {
      if (chip) { btn.setAttribute("data-asset", chip); return; }
      var pair = doc.createElement("span");
      pair.className = "pair";
      var intel = btn.cloneNode(false);
      btn.setAttribute("data-asset", "macArm");
      btn.textContent = "Download for Apple silicon";
      intel.setAttribute("data-asset", "macIntel");
      intel.textContent = "Download for Intel";
      var hint = doc.createElement("span");
      hint.className = "hint";
      hint.textContent = "About This Mac lists a Chip on Apple silicon and a Processor on Intel.";
      btn.parentNode.insertBefore(pair, btn);
      pair.appendChild(btn);
      pair.appendChild(intel);
      pair.parentNode.insertBefore(hint, pair.nextSibling);
    });
    if (chip !== "macIntel") return;
    doc.querySelectorAll(".files").forEach(function (list) {
      var row = list.querySelector('[data-os="mac"] [data-asset="macIntel"]');
      if (row) list.insertBefore(row.closest("div"), list.firstChild);
    });
  }

  var ready = os === "mac" ? macChip().then(macButtons) : Promise.resolve();
  if (typeof fetch === "function") {
    ready
      .then(function () { return fetch(API, { headers: { Accept: "application/vnd.github+json" } }); })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) { if (release) fill(release); })
      .catch(function () { /* the links already point at the release page */ });
  }
})();
