import { useEffect, useLayoutEffect, useRef } from 'react';
import { squiggleTurns, type SquigglePoint } from './editorial';
import { reducedMotion } from './theme';
import { time } from './ui';

// The squiggle is the app's "now playing" mark and its seek bar. Each song gets its own seeded
// organic wave (loud and quiet passages); the played portion swings at full height in the room's
// accent, the unplayed rest continues as the same line flattened and quiet, and a crisp vertical
// ink tick marks the playhead. While playing it breathes and gently ripples; paused it calms down;
// hidden or reduced motion draws still. Zero per-frame layout: ResizeObserver sizes the canvas.
const PLAYING_SPEED = 2.0, PAUSED_SPEED = 0.7, PAUSED_LIFT = .86;
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
const playingGap = () => coarse?.matches ? 1000 / 30 - 2 : 1000 / 60 - 2;
const pausedGap = () => coarse?.matches ? 1000 / 15 : 1000 / 30;

function traceCanvas(context: CanvasRenderingContext2D, points: readonly SquigglePoint[], left: number, mid: number, amp: number, phase: number, ripple: number) {
  const yOf = (p: SquigglePoint, idx: number) => {
    const drift = ripple > 0 ? Math.sin(idx * 0.85 - phase) * ripple : 0;
    return mid - (p.y + drift) * amp;
  };
  context.beginPath();
  context.moveTo(left + points[0].x, yOf(points[0], 0));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x;
    const ay = yOf(a, i - 1), by = yOf(b, i);
    context.bezierCurveTo(left + a.x + dx * a.lean, ay, left + b.x - dx * b.lean, by, left + b.x, by);
  }
  context.stroke();
}

export function Squiggle({ label, identity, position, duration, playing, color, rest, head, onSeek, live = false }: {
  label: string;
  // The queue entry playing. A drag that starts on one entry never seeks another.
  identity: string;
  position: number; duration: number; playing: boolean; color: string; rest: string; head?: string;
  onSeek(seconds: number, identity: string): void;
  // A live stream (an internet radio station): no position and nothing to seek.
  live?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ position, duration, playing, color, rest, head: head ?? color, live, identity, at: performance.now() });
  const dragging = useRef<number | null>(null);
  const gesture = useRef<{ identity: string; cancelled: boolean } | null>(null);
  const redraw = useRef(() => {});

  useLayoutEffect(() => {
    latest.current = { position, duration, playing, color, rest, head: head ?? color, live, identity, at: performance.now() };
    redraw.current();
  }, [position, duration, playing, color, rest, head, live, identity]);
  useEffect(() => {
    if (gesture.current && gesture.current.identity !== identity) { gesture.current.cancelled = true; dragging.current = null; redraw.current(); }
  }, [identity]);

  useLayoutEffect(() => {
    const element = canvas.current!;
    const context = element.getContext('2d');
    if (!context) return;
    const reduced = reducedMotion;
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined, last = performance.now(), phase = 0, spoken = '';
    let { width, height } = element.getBoundingClientRect();
    let speed = latest.current.playing ? PLAYING_SPEED : PAUSED_SPEED, lift = latest.current.playing ? 1 : PAUSED_LIFT;
    let cached: { width: number; seed: string; points: SquigglePoint[] } | null = null;
    const pointsFor = (span: number, seed: string) => {
      const w = Math.max(12, Math.round(span));
      if (cached && cached.width === w && cached.seed === seed) return cached.points;
      const points = squiggleTurns(w, seed || 'squiggly', 8.5);
      cached = { width: w, seed, points };
      return points;
    };

    const draw = (now: number) => {
      const { position: value, duration: length, playing: active, at, color: accent, rest: line, head: headColor, live: onAir, identity: seed } = latest.current;
      const elapsed = active ? Math.min((now - at) / 1000, 1) : 0;
      const seconds = dragging.current ?? Math.min(length, value + elapsed);
      const shown = onAir ? 'Live' : time(seconds);
      if (clock.current && clock.current.textContent !== shown) clock.current.textContent = shown;
      if (input.current) {
        const nextVal = String(Math.floor(seconds * 10) / 10);
        if (dragging.current === null && input.current.value !== nextVal) input.current.value = nextVal;
        const text = `${time(seconds)} of ${time(length)}`;
        if (text !== spoken) { spoken = text; input.current.setAttribute('aria-valuetext', text); }
      }
      if (width < 4 || height < 4) return;
      const ratio = devicePixelRatio || 1;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // Keep the exact 2px left/right bounds so pointer seeking aligns to the drawn wave.
      const mid = height / 2, left = 2, right = width - 2, span = Math.max(12, right - left);
      const amp = Math.min(12.5, Math.max(5.5, (height - 8) / 2));
      const frac = length > 0 ? Math.max(0, Math.min(1, seconds / length)) : 0;
      const x = onAir ? right : Math.max(left + 12, left + span * frac);
      const pts = pointsFor(span, seed);
      const ripple = reduced.matches ? 0 : active ? 0.14 : 0.05;

      context.lineCap = 'round';
      context.lineJoin = 'round';

      if (!onAir) {
        // Unplayed rest: the same song's wave, flattened and quiet.
        context.save();
        context.beginPath();
        context.rect(x, 0, width - x + 4, height);
        context.clip();
        context.strokeStyle = line;
        context.lineWidth = 1.6;
        traceCanvas(context, pts, left, mid, amp * 0.24, phase * 0.5, ripple * 0.35);
        context.restore();
      }

      // Played wave: full organic swing in the room's accent.
      context.save();
      context.beginPath();
      context.rect(0, 0, onAir ? width : x, height);
      context.clip();
      context.strokeStyle = accent;
      context.lineWidth = 2.4;
      traceCanvas(context, pts, left, mid, amp * lift, phase, ripple);
      context.restore();

      if (onAir) return;
      // Crisp vertical playhead tick in ink.
      context.strokeStyle = headColor;
      context.lineWidth = 2.6;
      context.beginPath();
      context.moveTo(x, mid - amp - 0.5);
      context.lineTo(x, mid + amp + 0.5);
      context.stroke();
    };
    const still = () => document.hidden || reduced.matches;
    const tick = (now: number) => {
      if (latest.current.playing && now - last < playingGap()) { frame = requestAnimationFrame(tick); return; }
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
      const settling = Math.abs(speed - (latest.current.playing ? PLAYING_SPEED : PAUSED_SPEED)) > .02;
      if (latest.current.playing || settling) frame = requestAnimationFrame(tick);
      else timer = setTimeout(() => { frame = requestAnimationFrame(tick); }, pausedGap());
    };
    const refresh = () => {
      cancelAnimationFrame(frame); clearTimeout(timer);
      last = performance.now();
      if (reduced.matches) phase = 0;
      draw(last); schedule();
    };
    redraw.current = () => draw(performance.now());
    const observer = new ResizeObserver(([entry]) => { ({ width, height } = entry.contentRect); redraw.current(); });
    observer.observe(element);
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
  return <div className={`squiggle${live ? ' live' : ''}`} {...(live ? { role: 'img', 'aria-label': label } : {})}>
    <span className="squiggle-time squiggle-elapsed" ref={clock} aria-hidden={live || undefined} />
    <div className="squiggle-rail">
      <canvas ref={canvas} aria-hidden="true" />
      {!live && <input ref={input} type="range" min="0" max={duration || 1} step="0.1" defaultValue={position} aria-label={label}
        onPointerDown={event => { gesture.current = { identity, cancelled: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onKeyDown={begin}
        onChange={event => {
          const value = Number(event.target.value);
          if (!gesture.current) { if (event.nativeEvent.type === 'input') onSeek(value, identity); return; }
          if (!gesture.current.cancelled && gesture.current.identity === identity) dragging.current = value;
          redraw.current();
        }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} onPointerCancel={end} />}
    </div>
    <span className="squiggle-time squiggle-total">{live ? '' : time(duration)}</span>
  </div>;
}
