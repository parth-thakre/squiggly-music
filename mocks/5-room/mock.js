// Rooms arrive: when one covers most of the viewport it's "in", its statement rises, and the
// bar takes the room's ink.
(function () {
  "use strict";
  var rooms = document.querySelectorAll("[data-room]");
  var bar = document.querySelector("[data-bar]");
  if (!("IntersectionObserver" in window)) { rooms.forEach(function (r) { r.classList.add("in"); }); return; }
  var current = null;
  function enter(room) {
    room.classList.add("in");
    current = room;
    if (bar) bar.style.setProperty("--bar", getComputedStyle(room).color);
  }
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) enter(e.target); });
  }, { rootMargin: "-38% 0px -38% 0px", threshold: 0 });
  rooms.forEach(function (r) { seen.observe(r); });
  addEventListener("mock:finish", function () { rooms.forEach(function (r) { r.classList.add("in"); }); });
})();
