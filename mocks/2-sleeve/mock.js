// Scroll pulls the record out of its sleeve. --p runs 0 to 1 over the stage; without this
// script, or with reduced motion, the CSS default of 1 shows everything already out.
(function () {
  "use strict";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");
  var wrap = document.querySelector(".stage-wrap");
  var stage = document.querySelector("[data-stage]");
  if (!wrap || !stage) return;
  var ticking = false, finished = false;
  function update() {
    ticking = false;
    if (finished) { stage.style.setProperty("--p", "1"); return; }
    if (reduced.matches) { stage.style.removeProperty("--p"); return; }
    var top = wrap.getBoundingClientRect().top;
    var travel = wrap.offsetHeight - innerHeight;
    var p = travel > 0 ? Math.max(0, Math.min(1, -top / travel)) : 1;
    // Ease the stretch so the disc leaves quickly and the inner sleeve settles slowly.
    p = 1 - Math.pow(1 - p, 1.6);
    stage.style.setProperty("--p", p.toFixed(4));
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  reduced.addEventListener("change", update);
  addEventListener("mock:finish", function () { finished = true; update(); });
  update();
})();
