import { useEffect, useRef, type RefObject } from 'react';
import { getPlayer, player } from './player';
import { reducedMotion } from './theme';

// Swiping the now-playing sleeve sideways changes songs: left for the next, right for the one
// before. The sleeve and title follow the finger (through --swipe-x on the deck), slide off when
// let go far enough or flicked, and the new song slides in from the side it was pulled toward.
// At either end of the queue the drag stretches and springs back. Touch and pen only, so mouse
// users keep text selection; vertical scrolling is left to the page.
const COMMIT = .3;        // share of the width that commits a swipe
const FLICK = .45;        // px per ms that commits a shorter swipe
const FLICK_MIN = 40;     // px a flick must still travel, so a twitch never skips a song
const OUT = 180, BACK = 220, IN = 280;

export function useSwipeSongs(deck: RefObject<HTMLElement | null>, trackKey: string | undefined) {
  const entering = useRef<'from-left' | 'from-right' | null>(null);

  // When the song changes after a swipe, the new sleeve enters from the far side.
  useEffect(() => {
    const element = deck.current;
    const from = entering.current;
    entering.current = null;
    if (!element || !from || reducedMotion.matches) return;
    element.dataset.enter = from;
    const timer = setTimeout(() => { delete element.dataset.enter; }, IN + 40);
    return () => clearTimeout(timer);
  }, [trackKey]);

  useEffect(() => {
    const element = deck.current;
    if (!element) return;
    let start: { x: number; y: number; t: number; id: number } | null = null;
    let dragging = false, dx = 0, lastX = 0, lastT = 0, velocity = 0, suppressClick = false;
    const set = (x: number, ms = 0) => {
      element.style.setProperty('--swipe-ms', `${ms}ms`);
      element.style.setProperty('--swipe-x', `${x}px`);
      element.style.setProperty('--swipe-fade', String(Math.max(.35, 1 - Math.abs(x) / (element.clientWidth * 1.4))));
    };
    const neighbour = (direction: 1 | -1) => {
      const { index, queue } = getPlayer();
      return index >= 0 && index + direction >= 0 && index + direction < queue.length;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || getPlayer().index < 0) return;
      if ((event.target as HTMLElement).closest('input, select, .squiggle, .transport, .lyrics')) return;
      start = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId };
      dragging = false; dx = 0; velocity = 0; lastX = event.clientX; lastT = event.timeStamp;
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const x = event.clientX - start.x, y = event.clientY - start.y;
      if (!dragging) {
        if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { start = null; return; }
        if (Math.abs(x) < 10) return;
        dragging = true;
        element.setPointerCapture(event.pointerId);
      }
      const dt = event.timeStamp - lastT;
      if (dt > 0) velocity = (event.clientX - lastX) / dt;
      lastX = event.clientX; lastT = event.timeStamp;
      // Pulling toward a song that doesn't exist stretches instead of following.
      dx = neighbour(x < 0 ? 1 : -1) ? x : x * .25;
      if (!reducedMotion.matches) set(dx);
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      start = null;
      if (!dragging) return;
      dragging = false; suppressClick = true;
      const direction: 1 | -1 = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) > element.clientWidth * COMMIT || (Math.abs(dx) > FLICK_MIN && Math.abs(velocity) > FLICK && Math.sign(velocity) === Math.sign(dx));
      if (!far || !neighbour(direction)) { set(0, BACK); return; }
      const { index, entryIds } = getPlayer();
      const go = () => {
        entering.current = direction === 1 ? 'from-right' : 'from-left';
        set(0, 0);
        player.jump(index + direction, entryIds[index + direction]);
      };
      if (reducedMotion.matches) { go(); return; }
      set(-direction * element.clientWidth, OUT);
      setTimeout(go, OUT);
    };
    const cancel = () => { if (dragging) set(0, BACK); start = null; dragging = false; };
    // A drag that ended on the strip's open button shouldn't also open the sheet.
    const click = (event: MouseEvent) => { if (suppressClick) { event.stopPropagation(); event.preventDefault(); } suppressClick = false; };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
      element.removeEventListener('click', click, true);
    };
  }, [deck, Boolean(trackKey)]);
}
