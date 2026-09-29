import { useEffect, useLayoutEffect, useRef } from 'react';
import { reducedMotion } from './theme';
import { time } from './ui';

// The squiggle is the app's "now playing" mark and its seek bar. It keeps squiggling while
// the window is visible: every frame while playing, a calmer 30 frames a second while paused.
// A hidden window draws nothing, and reduced motion gets a still wave. Position is
// interpolated locally between the occasional snapshots; no clock lives in app state.
// Radians per second the wave travels, and how tall it stands while paused (1 is full height).
const PLAYING_SPEED = 2.4, PAUSED_SPEED = 1.3, PAUSED_LIFT = .82;

export function Squiggle({ label, identity, position, duration, playing, color, rest, onSeek }: {
  label: string;
  // The queue entry playing. A drag that starts on one entry never seeks another.
  identity: string;
  position: number; duration: number; playing: boolean; color: string; rest: string;
  onSeek(seconds: number, identity: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ position, duration, playing, color, rest, at: performance.now() });
  const dragging = useRef<number | null>(null);
  const gesture = useRef<{ identity: string; cancelled: boolean } | null>(null);
  const redraw = useRef(() => {});

  useLayoutEffect(() => {
    latest.current = { position, duration, playing, color, rest, at: performance.now() };
    redraw.current();
  }, [position, duration, playing, color, rest]);
  useEffect(() => {
    // The song changed under a drag: drop the gesture, and keep it dropped until release.
    if (gesture.current && gesture.current.identity !== identity) { gesture.current.cancelled = true; dragging.current = null; redraw.current(); }
  }, [identity]);

  useLayoutEffect(() => {
    const element = canvas.current!;
    const context = element.getContext('2d');
    if (!context) return;
    // The system setting or the theme's motion token (reduced or none) both mean a still wave.
    const reduced = reducedMotion;
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined, last = performance.now(), phase = 0, spoken = '';
    let speed = latest.current.playing ? PLAYING_SPEED : PAUSED_SPEED, lift = latest.current.playing ? 1 : PAUSED_LIFT;
    const draw = (now: number) => {
      const { position: value, duration: length, playing: active, at, color: ink, rest: line } = latest.current;
      const elapsed = active ? Math.min((now - at) / 1000, 1) : 0;
      const seconds = dragging.current ?? Math.min(length, value + elapsed);
      if (clock.current) clock.current.textContent = time(seconds);
      if (input.current) {
        if (dragging.current === null) input.current.value = String(seconds);
        // Written only when the words change, so assistive tech isn't told sixty times a second.
        const text = `${time(seconds)} of ${time(length)}`;
        if (text !== spoken) { spoken = text; input.current.setAttribute('aria-valuetext', text); }
      }
      const { width, height } = element.getBoundingClientRect();
      const ratio = devicePixelRatio || 1;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // The range input's 4px thumb travels between these same points (app.css).
      const mid = height / 2, left = 2, right = width - 2;
      // At least one small wave is always drawn, so the first seconds squiggle too. That places
      // the thumb a little ahead of the true position for the opening moments only; the clock
      // and seeking stay exact.
      const end = Math.max(left + 22, left + (right - left) * (length > 0 ? Math.max(0, Math.min(1, seconds / length)) : 0));
      context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = 2.5;
      context.strokeStyle = line; context.beginPath(); context.moveTo(end + 7, mid); context.lineTo(right, mid); context.stroke();
      // The played part is always a full-height wave. On a short stretch the ends taper less and
      // the waves come closer together (unfurling to full length as the song plays), so even a
      // few seconds in shows a real squiggle rather than a flat line.
      const stop = end - 6, span = stop - left, taper = Math.max(1, Math.min(10, span / 5));
      const wavelength = Math.max(14, Math.min(34.5, span));
      if (span > 0) {
        context.strokeStyle = ink; context.beginPath();
        for (let x = left; ; x = Math.min(x + 1, stop)) {
          const t = Math.max(0, Math.min(1, (stop - x) / taper, (x - left) / taper));
          const y = mid + Math.sin((x - left) / wavelength * 2 * Math.PI - phase) * 4.5 * lift * t;
          if (x === left) context.moveTo(x, y); else context.lineTo(x, y);
          if (x >= stop) break;
        }
        context.stroke();
      }
      context.fillStyle = ink;
      context.beginPath(); context.roundRect(end - 2, mid - 9, 4, 18, 2); context.fill();
    };
    const still = () => document.hidden || reduced.matches;
    const tick = (now: number) => {
      // Slower while paused: still alive, clearly not playing.
      // Playing runs a touch faster and taller than paused, and the change eases in over about
      // half a second, so pressing play visibly winds the wave up.
      const dt = Math.min(now - last, 100) / 1000;
      const ease = 1 - Math.exp(-dt / .18);
      speed += ((latest.current.playing ? PLAYING_SPEED : PAUSED_SPEED) - speed) * ease;
      lift += ((latest.current.playing ? 1 : PAUSED_LIFT) - lift) * ease;
      phase += dt * speed;
      last = now;
      draw(now);
      schedule();
    };
    const schedule = () => {
      if (still()) return;
      // Every frame while playing, and while the speed is still easing between the two.
      const settling = Math.abs(speed - (latest.current.playing ? PLAYING_SPEED : PAUSED_SPEED)) > .02;
      if (latest.current.playing || settling) frame = requestAnimationFrame(tick);
      else timer = setTimeout(() => { frame = requestAnimationFrame(tick); }, 1000 / 30);
    };
    const refresh = () => {
      cancelAnimationFrame(frame); clearTimeout(timer);
      last = performance.now();
      if (reduced.matches) phase = 0;
      draw(last); schedule();
    };
    redraw.current = () => draw(performance.now());
    const observer = new ResizeObserver(() => redraw.current()); observer.observe(element);
    document.addEventListener('visibilitychange', refresh); reduced.addEventListener('change', refresh);
    refresh();
    return () => {
      cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect(); redraw.current = () => {};
      document.removeEventListener('visibilitychange', refresh); reduced.removeEventListener('change', refresh);
    };
  }, []);

  const begin = () => { gesture.current ??= { identity, cancelled: false }; };
  const end = () => { dragging.current = null; gesture.current = null; redraw.current(); };
  const commit = () => {
    const started = gesture.current, seconds = dragging.current;
    end();
    if (started && !started.cancelled && started.identity === identity && seconds !== null) onSeek(seconds, identity);
  };
  return <div className="squiggle">
    <span className="squiggle-time" ref={clock} />
    <div className="squiggle-rail">
      <canvas ref={canvas} aria-hidden="true" />
      <input ref={input} type="range" min="0" max={duration || 1} step="0.1" defaultValue={position} aria-label={label}
        onPointerDown={event => { gesture.current = { identity, cancelled: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onKeyDown={begin}
        onChange={event => {
          begin();
          // Every input redraws the thumb and clock, playing or paused.
          if (!gesture.current!.cancelled && gesture.current!.identity === identity) dragging.current = Number(event.target.value);
          redraw.current();
        }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} onPointerCancel={end} />
    </div>
    <span className="squiggle-time">{time(duration)}</span>
  </div>;
}
