// Fills download links from the latest GitHub release, the only request these pages make.
// Elements: [data-asset="setup|portable|rpm|sums"] get hrefs; [data-version] gets the
// version; [data-file="…"] gets the file name and size; [data-cta] puts the visitor's
// platform first. Without JS, or if the request fails, links point at the release page.
(function () {
  "use strict";
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
  function putFirst() {
    if (platform() !== "linux") return;
    var cta = document.querySelector("[data-cta]");
    if (!cta) return;
    var linux = cta.querySelector('[data-os="linux"]'), windows = cta.querySelector('[data-os="windows"]');
    if (!linux || !windows) return;
    cta.insertBefore(linux, cta.firstChild);
    linux.classList.add("primary"); windows.classList.remove("primary");
  }
  function setText(selector, text) {
    var nodes = document.querySelectorAll(selector);
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
      var links = document.querySelectorAll('[data-asset="' + key + '"]');
      for (var j = 0; j < links.length; j++) links[j].href = asset.browser_download_url;
      var file = document.querySelector('[data-file="' + key + '"]');
      if (file) file.textContent = asset.name + (asset.size > 1000000 ? " · " + Math.round(asset.size / 1000000) + " MB" : "");
    });
  }
  putFirst();
  if (typeof fetch === "function") {
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) { if (release) fill(release); })
      .catch(function () {});
  }
})();
