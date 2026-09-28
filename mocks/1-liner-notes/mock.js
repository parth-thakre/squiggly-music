// The gatefold, where the browser has no scroll-driven animations: open it with scroll by hand.
(function () {
  "use strict";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("animation-timeline: view()")) return;
  var fold = document.querySelector(".fold");
  if (!fold) return;
  function update() {
    var r = fold.getBoundingClientRect();
    var p = Math.max(0, Math.min(1, (innerHeight - r.top) / (innerHeight * 0.9)));
    fold.style.transform = "rotateY(" + (-38 * (1 - p)) + "deg)";
  }
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
})();
