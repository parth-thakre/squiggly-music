// Squiggly's site. Fills the download links from the latest GitHub release (the only request
// this page makes), and brings the app's own motion to the page: the squiggle, the room that
// takes its colours from what's playing, and lyrics that fill in word by word.
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
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
    if (/linux/i.test(p) && !/Android/i.test(ua)) return "linux";
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
    return "other";
  }

  function putFirst() {
    if (platform() !== "linux") return;
    var cta = doc.querySelector("[data-cta]");
    if (!cta) return;
    var linux = cta.querySelector('[data-os="linux"]');
    var windows = cta.querySelector('[data-os="windows"]');
    if (!linux || !windows) return;
    cta.insertBefore(linux, cta.firstChild);
    linux.classList.add("btn-primary");
    windows.classList.remove("btn-primary");
  }

  function setText(selector, text) {
    var nodes = doc.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }

  function fill(release) {
    var assets = release.assets || [];
    var version = String(release.tag_name || release.name || "").replace(/^v/, "");
    if (version) {
      setText("[data-version]", "Version " + version);
      setText("[data-version-long]", "Version " + version);
    }
    Object.keys(PATTERNS).forEach(function (key) {
      var asset = null;
      for (var i = 0; i < assets.length; i++) {
        if (PATTERNS[key].test(assets[i].name)) { asset = assets[i]; break; }
      }
      if (!asset) return;
      var links = doc.querySelectorAll('[data-asset="' + key + '"]');
      for (var j = 0; j < links.length; j++) links[j].href = asset.browser_download_url;
      var file = doc.querySelector('[data-file="' + key + '"]');
      if (file) {
        file.textContent = asset.name + (asset.size > 1000000 ? " · " + Math.round(asset.size / 1000000) + " MB" : "");
      }
    });
  }

  putFirst();
  if (typeof fetch === "function") {
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) { if (release) fill(release); })
      .catch(function () { /* the links already point at the release page */ });
  }

  /* ---------- Reveals, where the browser has no scroll-driven animations ---------- */

  var sda = typeof CSS !== "undefined" && CSS.supports && CSS.supports("animation-timeline: view()");
  if (!sda && "IntersectionObserver" in window) {
    root.classList.add("no-sda");
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    doc.querySelectorAll(".reveal").forEach(function (el) { revealer.observe(el); });
  }

  /* ---------- The room takes its colours from the section you're in ---------- */

  if ("IntersectionObserver" in window) {
    var metas = doc.querySelectorAll('meta[name="theme-color"]');
    var tinter = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var room = e.target.getAttribute("data-room");
        if (room === "paper") root.removeAttribute("data-room");
        else root.setAttribute("data-room", room);
        var ground = getComputedStyle(root).getPropertyValue("--ground").trim();
        for (var i = 0; i < metas.length; i++) {
          if (!metas[i].media || matchMedia(metas[i].media).matches) metas[i].setAttribute("content", ground);
        }
      });
    }, { rootMargin: "-50% 0px -49% 0px", threshold: 0 });
    doc.querySelectorAll("[data-room]").forEach(function (el) { tinter.observe(el); });
  }

  /* ---------- The squiggle ---------- */

  // The app's seek bar: a wave over the played part, a rounded playhead, and a flat rest line
  // ahead. k scales the whole thing from the app's 26 px rail. lift is the wave's height (1 is
  // full), and bump(x) lets a pointer lift the wave near it.
  function drawWave(c, w, h, progress, phase, lift, ink, k, bump) {
    var mid = h / 2, left = 2 * k, right = w - 2 * k;
    var end = Math.max(left + 22 * k, left + (right - left) * progress);
    c.clearRect(0, 0, w, h);
    c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = 2.5 * k;
    c.strokeStyle = ink; c.fillStyle = ink;
    c.globalAlpha = 0.3;
    c.beginPath(); c.moveTo(end + 7 * k, mid); c.lineTo(right, mid); c.stroke();
    c.globalAlpha = 1;
    var stop = end - 6 * k, span = stop - left;
    var taper = Math.max(k, Math.min(10 * k, span / 5));
    var wavelength = Math.max(14 * k, Math.min(34.5 * k, span));
    if (span > 0) {
      c.beginPath();
      for (var x = left; ; x = Math.min(x + 1, stop)) {
        var t = Math.max(0, Math.min(1, (stop - x) / taper, (x - left) / taper));
        var amp = 4.5 * k * lift * t * (bump ? bump(x) : 1);
        var y = mid + Math.sin((x - left) / wavelength * 2 * Math.PI - phase) * amp;
        if (x === left) c.moveTo(x, y); else c.lineTo(x, y);
        if (x >= stop) break;
      }
      c.stroke();
    }
    c.beginPath(); c.roundRect(end - 2 * k, mid - 9 * k, 4 * k, 18 * k, 2 * k); c.fill();
  }

  function fit(canvas) {
    var r = canvas.getBoundingClientRect();
    var ratio = devicePixelRatio || 1;
    var w = Math.round(r.width * ratio), h = Math.round(r.height * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    var c = canvas.getContext("2d");
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { c: c, w: r.width, h: r.height };
  }

  var PLAYING = 2.4, PAUSED = 1.3, PAUSED_LIFT = 0.82;

  // A wave that keeps time on its own: faster and taller while "playing", calmer while
  // paused, easing between the two over about half a second, as the app does. It draws every
  // frame while playing, 30 times a second while paused, and not at all while hidden.
  function liveWave(canvas, options) {
    var state = { speed: PAUSED, lift: PAUSED_LIFT, phase: 0, last: 0, frame: 0, timer: 0, playing: false, visible: true, progress: 0 };
    var ink = "#1c1b18";
    function draw(now) {
      var box = fit(canvas);
      drawWave(box.c, box.w, box.h, state.progress, state.phase, state.lift, ink, options.k, options.bump);
    }
    function tick(now) {
      var dt = Math.min(now - state.last, 100) / 1000;
      var ease = 1 - Math.exp(-dt / 0.18);
      state.speed += ((state.playing ? PLAYING : PAUSED) - state.speed) * ease;
      state.lift += ((state.playing ? 1 : PAUSED_LIFT) - state.lift) * ease;
      state.phase += dt * state.speed;
      state.last = now;
      if (options.step) options.step(dt, state);
      draw(now);
      schedule();
    }
    function still() { return doc.hidden || !state.visible || reduced.matches; }
    function schedule() {
      if (still()) return;
      var settling = Math.abs(state.speed - (state.playing ? PLAYING : PAUSED)) > 0.02;
      if (state.playing || settling || options.busy) state.frame = requestAnimationFrame(tick);
      else state.timer = setTimeout(function () { state.frame = requestAnimationFrame(tick); }, 1000 / 30);
    }
    function refresh() {
      cancelAnimationFrame(state.frame); clearTimeout(state.timer);
      state.last = performance.now();
      ink = getComputedStyle(canvas).color || ink;
      if (reduced.matches) state.phase = 0;
      draw(state.last); schedule();
    }
    // The ink eases with the room, so re-read it a few times through the crossfade.
    var recolor = new MutationObserver(function () {
      var n = 0, id = setInterval(function () { ink = getComputedStyle(canvas).color || ink; if (still()) draw(performance.now()); if (++n > 8) clearInterval(id); }, 100);
    });
    recolor.observe(root, { attributes: true, attributeFilter: ["data-room"] });
    if ("ResizeObserver" in window) new ResizeObserver(refresh).observe(canvas);
    doc.addEventListener("visibilitychange", refresh);
    reduced.addEventListener("change", refresh);
    if ("IntersectionObserver" in window && options.offscreen !== false) {
      new IntersectionObserver(function (entries) {
        state.visible = entries[0].isIntersecting; refresh();
      }, { threshold: 0 }).observe(canvas);
    }
    refresh();
    return {
      play: function (on) { if (state.playing !== on) { state.playing = on; if (on) refresh(); } },
      set: function (p) { state.progress = p; },
      redraw: refresh,
      state: state,
      options: options
    };
  }

  // The seek bar along the top: how far down the page you are. Scrolling is playing.
  var seekCanvas = doc.querySelector('[data-wave="seek"]');
  if (seekCanvas && seekCanvas.getContext) {
    var seek = liveWave(seekCanvas, { k: 1, offscreen: false });
    var scrollTimer = 0;
    function measure() {
      var max = root.scrollHeight - innerHeight;
      seek.set(max > 0 ? Math.max(0, Math.min(1, scrollY / max)) : 0);
    }
    measure();
    if (reduced.matches) seek.redraw();
    addEventListener("scroll", function () {
      measure();
      if (reduced.matches) { seek.redraw(); return; }
      seek.play(true);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () { seek.play(false); }, 220);
    }, { passive: true });
    addEventListener("resize", measure);
  }

  // The hero's squiggle: unfurls as the page opens, then keeps time. It lifts under a pointer.
  var heroCanvas = doc.querySelector('[data-wave="hero"]');
  if (heroCanvas && heroCanvas.getContext) {
    var target = 0.6, opened = reduced.matches ? 1 : 0, pointer = -1e9, pointerLift = 0;
    var hero = liveWave(heroCanvas, {
      k: 2,
      busy: true,
      bump: function (x) {
        var d = (x - pointer) / 90;
        return 1 + pointerLift * 0.7 * Math.exp(-d * d);
      },
      step: function (dt, state) {
        if (opened < 1) {
          opened = Math.min(1, opened + dt / 1.5);
          var e = 1 - Math.pow(1 - opened, 3);
          state.progress = target * e;
          state.playing = true;
        } else {
          hero.play(pointerLift > 0.01);
        }
        pointerLift += ((pointer > -1e8 ? 1 : 0) - pointerLift) * (1 - Math.exp(-dt / 0.25));
        hero.options.busy = opened < 1 || pointerLift > 0.01;
      }
    });
    hero.set(reduced.matches ? target : 0);
    if (reduced.matches) hero.redraw();
    var wrap = heroCanvas.parentNode;
    wrap.addEventListener("pointermove", function (e) {
      var r = heroCanvas.getBoundingClientRect();
      pointer = e.clientX - r.left;
      hero.play(true);
    });
    wrap.addEventListener("pointerleave", function () { pointer = -1e9; });
  }

  /* ---------- Lyrics, word by word ---------- */

  var sing = doc.querySelector("[data-sing]");
  if (sing) {
    var lines = Array.prototype.slice.call(sing.querySelectorAll(".sing-line"));
    var words = lines.map(function (line) { return Array.prototype.slice.call(line.querySelectorAll(".w")); });
    var running = false, visible = false, raf = 0, wait = 0;

    function clear() {
      lines.forEach(function (line, i) {
        line.classList.remove("past", "current");
        words[i].forEach(function (w) { w.classList.remove("on"); w.style.removeProperty("--p"); });
      });
    }
    // The still picture: two lines sung, the third under way.
    function pose() {
      clear();
      lines[0].classList.add("past"); lines[1].classList.add("past"); lines[2].classList.add("current");
      words[0].concat(words[1]).forEach(function (w) { w.classList.add("on"); });
      words[2].forEach(function (w, i) { if (i < 3) w.classList.add("on"); else if (i === 3) w.style.setProperty("--p", "0.55"); });
    }
    function duration(word) { return 130 + 46 * word.textContent.length; }

    function perform() {
      var li = 0, wi = 0, at = 0, start = 0, gap = 0;
      clear();
      lines[0].classList.add("current");
      function frame(now) {
        if (!running) return;
        if (!start) start = now;
        if (gap) {
          if (now < gap) { raf = requestAnimationFrame(frame); return; }
          gap = 0; start = now;
        }
        var word = words[li][wi];
        var p = Math.min(1, (now - start) / duration(word));
        word.style.setProperty("--p", p.toFixed(3));
        if (p >= 1) {
          word.classList.add("on"); word.style.removeProperty("--p");
          wi++; start = now;
          if (wi >= words[li].length) {
            lines[li].classList.remove("current"); lines[li].classList.add("past");
            li++; wi = 0;
            if (li >= lines.length) {
              // Hold the last line, fade everything back, and go again.
              wait = setTimeout(function () {
                clear();
                wait = setTimeout(function () { if (running) perform(); }, 900);
              }, 1700);
              return;
            }
            lines[li].classList.add("current");
            gap = now + 380;
          }
        }
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
    }
    function update() {
      var should = visible && !doc.hidden && !reduced.matches;
      if (should && !running) { running = true; perform(); }
      if (!should && running) { running = false; cancelAnimationFrame(raf); clearTimeout(wait); pose(); }
    }
    pose();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; update(); }, { threshold: 0.4 }).observe(sing);
    }
    doc.addEventListener("visibilitychange", update);
    reduced.addEventListener("change", update);
  }
})();
