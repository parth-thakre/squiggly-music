// The page is sung. Each line fills word by word as it passes the "now" line, a little above
// the middle of the viewport; the first stanza sings itself on load until you scroll. The
// deck's squiggle is the app's seek bar, with the page as the song.
(function () {
  "use strict";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");
  var sheet = document.querySelector("[data-sheet]");
  if (!sheet) return;
  var LENGTH = 233; // 3:53, the song in the screenshots.

  // Split lines into words, and stamp the first line of each stanza with its time.
  var lines = Array.prototype.slice.call(sheet.querySelectorAll(".line"));
  lines.forEach(function (line) {
    var words = line.textContent.trim().split(/\s+/);
    line.textContent = "";
    words.forEach(function (w, i) {
      var s = document.createElement("span"); s.className = "w"; s.textContent = w; line.appendChild(s);
      if (i < words.length - 1) line.appendChild(document.createTextNode(" "));
    });
  });
  var stamps = [];
  sheet.querySelectorAll(".stanza").forEach(function (stanza) {
    var first = stanza.querySelector(".line");
    var s = document.createElement("span"); s.className = "stamp"; s.setAttribute("aria-hidden", "true");
    first.insertBefore(s, first.firstChild); stamps.push({ el: s, line: first });
  });
  function clock(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }
  function stamp() {
    var total = document.documentElement.scrollHeight - innerHeight;
    stamps.forEach(function (s) {
      var y = s.line.getBoundingClientRect().top + scrollY - innerHeight * 0.42;
      s.el.textContent = clock(Math.max(0, Math.min(1, y / total)) * LENGTH);
    });
  }

  // Fill state per line from its position.
  var performing = !reduced.matches, performStart = 0, performLines = lines.slice(0, 5);
  function setLine(line, lp) {
    var words = line.querySelectorAll(".w"), n = words.length;
    var cls = lp >= 1 ? "past" : lp > 0 ? "current" : "";
    if (line.dataset.state !== cls) { line.classList.remove("past", "current"); if (cls) line.classList.add(cls); line.dataset.state = cls; }
    if (cls !== "current") return;
    for (var i = 0; i < n; i++) {
      var p = Math.max(0, Math.min(1, lp * n - i));
      words[i].style.setProperty("--p", p.toFixed(3));
    }
  }
  function layout() {
    var now = innerHeight * 0.42;
    if (finished) { lines.forEach(function (l) { setLine(l, 1); }); return; }
    lines.forEach(function (line) {
      if (performing && performLines.indexOf(line) >= 0) return;
      var r = line.getBoundingClientRect();
      var lp = (now - (r.top - r.height * 0.2)) / (r.height * 1.4);
      setLine(line, Math.max(0, Math.min(1, lp)));
    });
  }

  // The opening: the first stanza sings itself, one word at a time, until you scroll.
  function perform(now) {
    if (!performing) return;
    if (!performStart) performStart = now + 400;
    var t = now - performStart, done = true;
    performLines.forEach(function (line) {
      var words = line.querySelectorAll(".w"), n = words.length, ms = 0, start = 0;
      for (var i = 0; i < n; i++) ms += 140 + 42 * words[i].textContent.length;
      start = Number(line.dataset.start || 0);
      var lp = t < start ? 0 : Math.min(1, (t - start) / ms);
      if (lp < 1) done = false;
      setLine(line, lp);
    });
    if (done) { performing = false; seek.play(false); return; }
    requestAnimationFrame(perform);
  }
  (function schedule() {
    var at = 0;
    performLines.forEach(function (line) {
      line.dataset.start = at;
      var words = line.querySelectorAll(".w"), ms = 0;
      for (var i = 0; i < words.length; i++) ms += 140 + 42 * words[i].textContent.length;
      at += ms + 420;
    });
  })();

  /* The deck's squiggle: the app's seek bar drawing, scroll as the song's position. */
  var canvas = document.querySelector("[data-seek]");
  var nowEl = document.querySelector("[data-now]");
  var PLAYING = 2.4, PAUSED = 1.3, PAUSED_LIFT = 0.82;
  var seek = { speed: PAUSED, lift: PAUSED_LIFT, phase: 0, last: 0, playing: false, frame: 0, timer: 0, progress: 0,
    play: function (on) { if (this.playing !== on) { this.playing = on; refresh(); } } };
  function draw() {
    if (!canvas) return;
    var r = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    var w = r.width, h = r.height;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    var c = canvas.getContext("2d");
    c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, w, h);
    var ink = getComputedStyle(canvas).color, head = getComputedStyle(document.documentElement).getPropertyValue("--head").trim() || ink;
    var mid = h / 2, left = 2, right = w - 2;
    var end = Math.max(left + 22, left + (right - left) * seek.progress);
    c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = 2.5;
    c.strokeStyle = ink; c.globalAlpha = 0.3; c.beginPath(); c.moveTo(end + 7, mid); c.lineTo(right, mid); c.stroke(); c.globalAlpha = 1;
    var stop = end - 6, span = stop - left, taper = Math.max(1, Math.min(10, span / 5)), wl = Math.max(14, Math.min(34.5, span));
    if (span > 0) {
      c.strokeStyle = head; c.beginPath();
      for (var x = left; ; x = Math.min(x + 1, stop)) {
        var t = Math.max(0, Math.min(1, (stop - x) / taper, (x - left) / taper));
        var y = mid + Math.sin((x - left) / wl * 2 * Math.PI - seek.phase) * 4.5 * seek.lift * t;
        if (x === left) c.moveTo(x, y); else c.lineTo(x, y);
        if (x >= stop) break;
      }
      c.stroke();
    }
    c.fillStyle = head; c.beginPath(); c.roundRect(end - 2, mid - 9, 4, 18, 2); c.fill();
  }
  function tick(now) {
    var dt = Math.min(now - seek.last, 100) / 1000, ease = 1 - Math.exp(-dt / 0.18);
    seek.speed += ((seek.playing ? PLAYING : PAUSED) - seek.speed) * ease;
    seek.lift += ((seek.playing ? 1 : PAUSED_LIFT) - seek.lift) * ease;
    seek.phase += dt * seek.speed; seek.last = now;
    draw(); schedule();
  }
  function schedule() {
    if (document.hidden || reduced.matches) return;
    var settling = Math.abs(seek.speed - (seek.playing ? PLAYING : PAUSED)) > 0.02;
    if (seek.playing || settling) seek.frame = requestAnimationFrame(tick);
    else seek.timer = setTimeout(function () { seek.frame = requestAnimationFrame(tick); }, 1000 / 30);
  }
  function refresh() {
    cancelAnimationFrame(seek.frame); clearTimeout(seek.timer);
    seek.last = performance.now(); if (reduced.matches) seek.phase = 0;
    draw(); schedule();
  }
  function measure() {
    var total = document.documentElement.scrollHeight - innerHeight;
    seek.progress = total > 0 ? Math.max(0, Math.min(1, scrollY / total)) : 0;
    if (nowEl) nowEl.textContent = clock(seek.progress * LENGTH);
  }

  var scrollTimer = 0, ticking = false, finished = false;
  function onScroll() {
    if (performing && scrollY > 8) { performing = false; }
    if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; measure(); layout(); if (reduced.matches) draw(); }); }
    if (!reduced.matches) { seek.play(true); clearTimeout(scrollTimer); scrollTimer = setTimeout(function () { seek.play(false); }, 220); }
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", function () { stamp(); measure(); layout(); refresh(); });
  document.addEventListener("visibilitychange", refresh);
  reduced.addEventListener("change", function () { performing = false; layout(); refresh(); });
  addEventListener("mock:finish", function () { performing = false; finished = true; layout(); });

  document.documentElement.classList.add("live");
  stamp(); measure(); layout(); refresh();
  if (performing) { seek.play(true); requestAnimationFrame(perform); }
})();
