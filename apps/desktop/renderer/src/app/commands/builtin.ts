import { resetLibraryCaches } from '../library';
import { createPlaylist } from '../menu';
import { current, getPlayer, optimisticVolume, player } from '../player';
import { registry, type Command } from '../registry';
import { nav, type Route } from '../route';
import { getThemes, onThemesChange, selectTheme } from '../theme';
import { splitTitle } from '../ui';
import { openConfigFolder } from '../config';
import { setRating } from '../ratings';
import { following, nextRepeat } from '../../../../../../packages/core/playOrder';
import { onCommandError } from './keymap';
import { togglePalette } from './palette-state';

// Every built-in action, registered through a registry scope like any other owner's.
// Their default keys live here; keybindings.json changes them.
const builtin = registry.scope('builtin');
import.meta.hot?.dispose(() => builtin.dispose());
onCommandError(message => player.showError(message));

export { shell } from '../nowPlaying';
import { shell } from '../nowPlaying';

const phone = () => matchMedia('(max-width: 760px)').matches;
const desktop = () => !!window.squiggly;
const playing = () => !!current(getPlayer());
const fail = (error: string | null | undefined) => { if (error) player.showError(error); };
const add = (command: Command) => builtin.command(command);

// Playback
let beforeMute: number | null = null;
const volumeNow = () => optimisticVolume?.value ?? getPlayer().volume;
const setVolume = (percent: number) => player.volume(Math.max(0, Math.min(100, Math.round(percent))), true);
const seekBy = (seconds: number) => {
  const state = getPlayer();
  const length = state.duration || (current(state)?.duration ?? 0);
  player.seek(Math.max(0, Math.min(length > 0 ? length - .5 : Infinity, state.position + seconds)));
};
add({ id: 'toggle', title: 'Play or pause', category: 'Playback', keys: ['space'], when: playing, run: () => player.toggle() });
add({ id: 'next', title: 'Next song', category: 'Playback', keys: ['ctrl+right'], when: () => following(getPlayer().index, getPlayer().queue.length, getPlayer().repeat, 'skip') >= 0, run: () => player.next() });
add({ id: 'previous', title: 'Previous song', category: 'Playback', keys: ['ctrl+left'], when: playing, run: () => player.previous() });
add({ id: 'seek-forward', title: 'Skip ahead 10 seconds', category: 'Playback', keys: ['shift+right'], repeat: true, when: playing, run: () => seekBy(10) });
add({ id: 'seek-back', title: 'Go back 10 seconds', category: 'Playback', keys: ['shift+left'], repeat: true, when: playing, run: () => seekBy(-10) });
add({ id: 'volume-up', title: 'Volume up', category: 'Playback', keys: ['ctrl+up'], repeat: true, run: () => { beforeMute = null; setVolume(volumeNow() + 5); } });
add({ id: 'volume-down', title: 'Volume down', category: 'Playback', keys: ['ctrl+down'], repeat: true, run: () => { beforeMute = null; setVolume(volumeNow() - 5); } });
add({
  id: 'mute', title: 'Mute or unmute', category: 'Playback', keys: ['m'],
  run: () => {
    const now = volumeNow();
    if (now > 0) { beforeMute = now; setVolume(0); } else { setVolume(beforeMute ?? 100); beforeMute = null; }
  },
});
// Ratings for the playing song, which must be from the server. setRating shows its own failures.
// Ctrl+1 to Ctrl+5 work in the search field too, as Ctrl+Right does: Ctrl chords are commands there.
const playingOnServer = () => getPlayer().connected && current(getPlayer())?.source === 'navidrome';
for (const n of [1, 2, 3, 4, 5] as const) add({
  id: `rate-${n}`, title: `Rate the playing song ${n === 1 ? '1 star' : `${n} stars`}`, category: 'Playback', keys: [`ctrl+${n}`],
  when: playingOnServer, run: async () => { await setRating('track', [current(getPlayer())!.id], n); },
});
add({
  id: 'rate-clear', title: 'Clear the playing song\'s rating', category: 'Playback',
  when: playingOnServer,
  run: async () => { await setRating('track', [current(getPlayer())!.id], 0); },
});

// Playback modes: queue behaviour, so they work with nothing playing too.
add({ id: 'repeat', title: 'Cycle repeat', category: 'Playback', keys: ['r'], run: () => player.repeat(nextRepeat(getPlayer().repeat)) });
add({ id: 'shuffle', title: 'Shuffle on or off', category: 'Playback', keys: ['s'], run: () => player.shuffle(!getPlayer().shuffle) });

// Go to
const places: [id: string, title: string, route: Route, key: string][] = [
  ['records', 'Go to records', { view: 'records' }, 'g r'],
  ['artists', 'Go to artists', { view: 'artists' }, 'g a'],
  ['tracks', 'Go to tracks', { view: 'tracks' }, 'g t'],
  ['playlists', 'Go to playlists', { view: 'playlists' }, 'g p'],
  ['favorites', 'Go to favorites', { view: 'favorites' }, 'g f'],
  ['queue', 'Go to the queue', { view: 'queue' }, 'g q'],
  ['lyrics', 'Go to lyrics', { view: 'lyrics' }, 'g l'],
  ['settings', 'Go to settings', { view: 'settings' }, 'g s'],
  ['genres', 'Go to genres', { view: 'genres' }, 'g g'],
];
for (const [id, title, route, key] of places) add({ id: `go-${id}`, title, category: 'Go to', keys: id === 'settings' ? [key, 'ctrl+,'] : [key], run: () => nav.go(route) });
add({ id: 'back', title: 'Back', category: 'Go to', keys: ['alt+left'], run: () => nav.back() });
add({ id: 'forward', title: 'Forward', category: 'Go to', keys: ['alt+right'], run: () => history.forward() });
add({
  id: 'search', title: 'Search the library', category: 'Go to', keys: ['/'],
  when: () => !!document.querySelector('.search'),
  run: () => { const field = document.querySelector<HTMLInputElement>('.search'); field?.focus(); field?.select(); },
});

// Queue
add({ id: 'clear-up-next', title: 'Clear up next', category: 'Queue', when: () => getPlayer().queue.length - getPlayer().index - 1 > 0, run: () => player.clear() });
add({
  id: 'save-queue', title: 'Save the queue as a playlist', category: 'Queue',
  when: () => getPlayer().connected && getPlayer().queue.some(t => t.source === 'navidrome'),
  async run() {
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    fail(await createPlaylist(`Queue, ${date}`, getPlayer().queue.filter(t => t.source === 'navidrome').map(t => t.id)));
  },
});

// Radio
add({
  id: 'radio-start', title: 'Start radio from this song', category: 'Radio',
  when: () => getPlayer().connected && current(getPlayer())?.source === 'navidrome',
  run: () => { const track = current(getPlayer())!; return player.radio({ kind: 'song', track, label: splitTitle(track.title).main }); },
});
add({ id: 'radio-stop', title: 'Stop radio', category: 'Radio', when: () => !!getPlayer().radio, run: () => player.stopRadio() });

// Now playing: the song on the deck, from anywhere. Only songs from the server have favorites,
// a record, and an artist to go to; every song has its details.
import { firstArtistId } from '../credits';
import { isStarred, setStarred } from '../favorites';
import { openSongDetails } from '../menu';
const playingSong = () => { const track = current(getPlayer()); return getPlayer().connected && track?.source === 'navidrome' ? track : undefined; };
// The first credited artist, as the deck's credit links it.
const playingArtist = () => { const track = playingSong(); return track && firstArtistId(track); };
add({
  id: 'favorite-current', title: 'Add or remove the playing song from favorites', category: 'Now playing', keys: ['f'],
  when: () => !!playingSong(),
  async run() {
    const track = playingSong()!;
    const result = await setStarred('track', [track.id], !isStarred(track.id, track.starred));
    if (!result.ok) fail(result.error);
  },
});
add({ id: 'go-current-album', title: 'Go to the playing record', category: 'Now playing', keys: ['g c'], when: () => !!playingSong()?.albumId, run: () => nav.go({ view: 'album', id: playingSong()!.albumId! }) });
add({ id: 'go-current-artist', title: 'Go to the playing artist', category: 'Now playing', keys: ['g .'], when: () => !!playingArtist(), run: () => nav.go({ view: 'artist', id: playingArtist()! }) });
add({ id: 'song-details-current', title: "Show the playing song's details", category: 'Now playing', when: playing, run: () => openSongDetails(current(getPlayer())!) });

// Sleep timer: pauses after a while or after this song (./sleep.ts). The deck says when.
import { sleepTimer } from './sleep';
for (const minutes of [15, 30, 60]) add({ id: `sleep-${minutes}`, title: `Sleep in ${minutes} minutes`, category: 'Sleep timer', when: playing, run: () => sleepTimer.sleepIn(minutes) });
add({ id: 'sleep-after-song', title: 'Sleep after this song', category: 'Sleep timer', when: playing, run: () => { sleepTimer.sleepAfterSong(); } });
add({ id: 'sleep-cancel', title: 'Cancel the sleep timer', category: 'Sleep timer', when: () => !!sleepTimer.get(), run: () => sleepTimer.cancel() });

// View
add({ id: 'palette', title: 'Show all commands', category: 'View', keys: ['ctrl+k'], run: () => togglePalette() });
add({
  id: 'mini-player', title: 'Switch to the mini player', category: 'View', when: desktop,
  async run() { const result = await window.squiggly!.window.toggleMini(); if (!result.ok) fail(result.error); },
});
add({ id: 'now-playing', title: 'Open now playing', category: 'View', when: () => phone() && playing() && !!shell.openNowPlaying, run: () => shell.openNowPlaying?.() });

// Library
add({ id: 'refresh', title: 'Refresh the library', category: 'Library', when: () => getPlayer().connected, run: () => resetLibraryCaches() });

// App
add({ id: 'open-config', title: 'Open the config folder', category: 'App', when: () => !!window.squiggly?.config, run: async () => fail(await openConfigFolder()) });
add({
  id: 'reload-extensions', title: 'Reload extensions', category: 'App', when: () => !!window.squiggly?.extensions,
  async run() { const result = await window.squiggly!.extensions.reload(); if (!result.ok) fail(result.error); },
});

// One command per theme, so "Theme: Night" is a keystroke away and can be bound.
const themeScope = registry.scope('theme');
import.meta.hot?.dispose(() => themeScope.dispose());
let themeIds = '';
function syncThemeCommands() {
  const { themes } = getThemes();
  const ids = themes.map(theme => `${theme.id}=${theme.name}`).join('|');
  if (ids === themeIds) return;
  themeIds = ids;
  themeScope.dispose();
  for (const theme of themes) themeScope.command({
    id: theme.id.replace(':', '.'), title: `Theme: ${theme.name}`, category: 'Theme',
    when: () => getThemes().chosen !== theme.id, run: () => selectTheme(theme.id),
  });
}
syncThemeCommands();
onThemesChange(syncThemeCommands);
