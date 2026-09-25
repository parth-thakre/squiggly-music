// Last.fm's scrobble rule, shared by the desktop main process and the browser build:
// a song longer than 30 seconds counts once half of it, or four minutes, has played.
export const finishThreshold = (duration: number) => duration > 30 ? Math.min(duration / 2, 240) : null;
