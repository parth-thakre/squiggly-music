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
    sums: /^SHA256SUMS$/
  };

  function platform() {
    var ua = navigator.userAgent || "";
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android/i.test(p + ua)) return "android";
    if (/win/i.test(p) || /Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(p + ua)) return "linux";
    return "other";
  }

  // The visitor's system gets the one filled button, and its files lead the list. The other
  // systems follow as a quiet "Also for" line. Anything without a build (a Mac, an iPhone) gets
  // Windows, the page's own first choice.
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

  if (typeof fetch === "function") {
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) { if (release) fill(release); })
      .catch(function () { /* the links already point at the release page */ });
  }
})();
