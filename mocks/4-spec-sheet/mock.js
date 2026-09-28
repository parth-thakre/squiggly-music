// The front panel: power-up on load, and the squiggle as a trace on the display.
(function () {
  "use strict";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");
  var face = document.querySelector(".panel-face");
  var switches = document.querySelectorAll("[data-switch]");
  var value = document.querySelector("[data-knob-value]");

  // Power up: the switches settle to off one by one, the knob sweeps to 100, the display lights.
  function powerUp() {
    if (reduced.matches) {
      face.classList.add("up");
      switches.forEach(function (s) { s.classList.add("set"); });
      return;
    }
    setTimeout(function () { face.classList.add("up"); }, 300);
    switches.forEach(function (s, i) { setTimeout(function () { s.classList.add("set"); }, 700 + i * 140); });
    var start = 0;
    function count(now) {
      if (!start) start = now;
      var t = Math.min(1, (now - start) / 1400), e = 1 - Math.pow(1 - t, 3);
      if (value) value.textContent = Math.round(e * 100);
      if (t < 1) requestAnimationFrame(count);
    }
    setTimeout(function () { requestAnimationFrame(count); }, 300);
  }
  powerUp();

  // The trace: the app's seek-bar wave, drawn as a scope trace across the whole display.
  var canvas = document.querySelector("[data-scope]");
  if (!canvas || !canvas.getContext) return;
  var phase = 0, last = 0, frame = 0;
  function draw(now) {
    var r = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    var w = r.width, h = r.height;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    var c = canvas.getContext("2d");
    c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, w, h);
    var mid = h / 2, left = 6, right = w - 6, end = right - 30;
    var amber = getComputedStyle(canvas).color;
    c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = 2;
    c.strokeStyle = amber; c.shadowColor = "rgba(240,176,74,.6)"; c.shadowBlur = 6;
    c.beginPath();
    var wl = 46, taper = 12, stop = end - 8;
    for (var x = left; ; x = Math.min(x + 1, stop)) {
      var t = Math.max(0, Math.min(1, (stop - x) / taper, (x - left) / taper));
      var y = mid + Math.sin((x - left) / wl * 2 * Math.PI - phase) * (h * 0.32) * t;
      if (x === left) c.moveTo(x, y); else c.lineTo(x, y);
      if (x >= stop) break;
    }
    c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = amber; c.beginPath(); c.roundRect(end - 1.5, mid - h * 0.42, 3, h * 0.84, 1.5); c.fill();
    c.globalAlpha = 0.35; c.beginPath(); c.moveTo(end + 8, mid); c.lineTo(right, mid); c.stroke(); c.globalAlpha = 1;
  }
  function tick(now) {
    var dt = Math.min(now - last, 100) / 1000;
    phase += dt * 2.4; last = now;
    draw(now);
    if (!document.hidden && !reduced.matches) frame = requestAnimationFrame(tick);
  }
  function refresh() {
    cancelAnimationFrame(frame); last = performance.now();
    if (reduced.matches) { phase = 0; draw(last); return; }
    frame = requestAnimationFrame(tick);
  }
  canvas.style.color = "#f0b04a";
  document.addEventListener("visibilitychange", refresh);
  reduced.addEventListener("change", refresh);
  new ResizeObserver(function () { draw(performance.now()); }).observe(canvas);
  refresh();
})();
