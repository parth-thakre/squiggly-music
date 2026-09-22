import { useEffect, useRef, useState } from 'react';

export function time(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function SeekBar({ trackIdentity, position, duration, playing, disabled, onSeek }: {
  trackIdentity: string; position: number; duration: number; playing: boolean; disabled: boolean; onSeek(value: number): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const latest = useRef({ position, duration, playing, at: performance.now() });
  const dragging = useRef<number | null>(null);
  const gesture = useRef<{ trackIdentity: string; cancelled: boolean } | null>(null);
  const redraw = useRef<() => void>(() => {});
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => { latest.current = { position, duration, playing, at: performance.now() }; }, [position, duration, playing, trackIdentity]);
  useEffect(() => {
    if (gesture.current && (gesture.current.trackIdentity !== trackIdentity || disabled)) {
      // Keep the cancelled gesture until release so further input cannot retarget it.
      gesture.current.cancelled = true; dragging.current = null; setScrubbing(false); redraw.current();
    }
  }, [trackIdentity, disabled]);
  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext('2d');
    if (!context) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const draw = (now: number) => {
      const { position: value, duration: length, playing: active, at } = latest.current;
      const elapsed = active ? Math.min((now - at) / 1000, 1) : 0;
      const seconds = dragging.current ?? Math.min(length, value + elapsed);
      if (input.current && dragging.current === null) input.current.value = String(seconds);
      if (clock.current) clock.current.textContent = time(seconds);
      const { width, height } = element.getBoundingClientRect();
      const ratio = devicePixelRatio || 1;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const left = 8; const right = width - 8;
      const end = left + (right - left) * (length > 0 ? Math.max(0, Math.min(1, seconds / length)) : 0);
      context.lineCap = 'round'; context.lineWidth = 2;
      context.strokeStyle = '#495363'; context.beginPath(); context.moveTo(end, height / 2); context.lineTo(right, height / 2); context.stroke();
      context.strokeStyle = '#a8c8f8'; context.beginPath();
      // Position-based phase freezes on pause. No perpetual animation at idle.
      const phase = reduced.matches ? 0 : seconds * 2;
      for (let x = left; x <= end; x++) {
        const taper = Math.min(1, (end - x) / 12, (x - left) / 12);
        const y = height / 2 + Math.sin((x - left) / 6 - phase) * 4 * Math.max(0, taper);
        if (x === left) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke(); context.fillStyle = '#d5e4fc'; context.beginPath(); context.arc(end, height / 2, 5, 0, Math.PI * 2); context.fill();
    };
    const animate = (now: number) => { draw(now); if (!document.hidden && playing && !reduced.matches) frame = requestAnimationFrame(animate); };
    redraw.current = () => draw(performance.now());
    const refresh = () => { cancelAnimationFrame(frame); animate(performance.now()); };
    const observer = new ResizeObserver(refresh); observer.observe(element);
    document.addEventListener('visibilitychange', refresh); reduced.addEventListener('change', refresh);
    refresh();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', refresh); reduced.removeEventListener('change', refresh); };
  }, [playing, position, duration, scrubbing]);

  const cancel = () => { dragging.current = null; gesture.current = null; setScrubbing(false); redraw.current(); };
  const commit = () => {
    if (!disabled && gesture.current?.trackIdentity === trackIdentity && !gesture.current.cancelled && dragging.current !== null) onSeek(dragging.current);
    cancel();
  };
  return <div className="seek-control">
    <div className="seek-rail">
      <canvas ref={canvas} aria-hidden="true" />
      <input ref={input} aria-label="Playback position" aria-valuetext={`${time(position)} of ${time(duration)}`}
        type="range" min="0" max={duration || 1} step="0.1" defaultValue="0" disabled={disabled || !duration}
        onPointerDown={event => { gesture.current = { trackIdentity, cancelled: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onKeyDown={() => { gesture.current ??= { trackIdentity, cancelled: false }; }}
        onChange={event => {
          gesture.current ??= { trackIdentity, cancelled: false };
          if (disabled || gesture.current.cancelled || gesture.current.trackIdentity !== trackIdentity) { redraw.current(); return; }
          dragging.current = Number(event.target.value); setScrubbing(true); redraw.current();
        }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        onPointerCancel={cancel} onLostPointerCapture={cancel} />
    </div>
    <div className="time-labels"><span ref={clock}>{time(position)}</span><span>{time(duration)}</span></div>
  </div>;
}
