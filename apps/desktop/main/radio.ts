import { Effect } from 'effect';
import type { AlbumDetail, PlayerSnapshot, RadioSeed, Track } from '../../../packages/core/contracts';

export interface RadioClient {
  topSongs(artistId: string, count: number): Effect.Effect<Track[], Error>;
  album(id: string): Effect.Effect<AlbumDetail, Error>;
  similarSongs(id: string, count: number): Effect.Effect<Track[], Error>;
}
export interface RadioShell<C extends RadioClient> {
  client(): C | null;
  player(): PlayerSnapshot;
  known(id: string): Track | undefined;
  // Adds tracks to the main process's bounded known-track map.
  remember(tracks: readonly Track[]): void;
  replace(client: C, tracks: Track[]): Effect.Effect<void, Error>;
  append(client: C, tracks: Track[]): Effect.Effect<void, Error>;
  // Runs a background top-up (a bounded lane, with metrics).
  background(task: Effect.Effect<void, Error>): Promise<unknown>;
  changed(): void;
}
const distinct = (tracks: readonly Track[]) => [...new Map(tracks.map(track => [track.id, track])).values()];

// Radio lives in the main process, not in a window, so it keeps topping up while every window
// is hidden. Each station has a generation. Starting a station or any other playback bumps the
// counter, so a start or top-up that finishes late never touches a newer queue.
export class Radio<C extends RadioClient> {
  private generation = 0;
  private station: { generation: number; view: { label: string }; topping: boolean; tried: { entry: string; at: number } | null } | null = null;
  constructor(private shell: RadioShell<C>, private limit = 1000) {}

  get view(): { label: string } | null { return this.station?.view ?? null; }

  // Call just before any other playback replaces the queue, and when the engine or session goes away.
  end() {
    this.generation++;
    if (this.station) { this.station = null; this.shell.changed(); }
  }

  // Asking the server for songs like an artist can take over ten seconds, so artist and record
  // radio start from a song: an artist's top song, or a record's first track.
  start(seed: RadioSeed): Effect.Effect<void, Error> {
    const radio = this;
    return Effect.gen(function* () {
      const client = radio.shell.client();
      if (!client) return yield* Effect.fail(new Error('Connect to a server first.'));
      const generation = ++radio.generation;
      const start = seed.kind === 'song' ? radio.shell.known(seed.trackId)
        : seed.kind === 'artist' ? (yield* client.topSongs(seed.id, 5))[0] : (yield* client.album(seed.id)).tracks[0];
      if (!start && seed.kind === 'song') return yield* Effect.fail(new Error('That song is no longer loaded. Refresh the library and try again.'));
      if (!start) return yield* Effect.fail(new Error('Radio needs a song to start from, and none was found.'));
      const tracks = distinct([start, ...(yield* client.similarSongs(start.id, 40))]).slice(0, radio.limit);
      if (tracks.length < 2) return yield* Effect.fail(new Error('Your server found nothing similar to play. Radio needs artist information on the server.'));
      if (generation !== radio.generation || radio.shell.client() !== client) return yield* Effect.fail(new Error('Playback changed before the radio could start.'));
      radio.shell.remember(tracks);
      // The previous station ends here, so none of its top-ups can reach the new queue.
      if (radio.station) { radio.station = null; radio.shell.changed(); }
      yield* radio.shell.replace(client, tracks);
      if (generation !== radio.generation) return;
      radio.station = { generation, view: { label: seed.label }, topping: false, tried: null };
      radio.shell.changed();
    });
  }

  // Called for every player snapshot. When three or fewer entries follow the current one, appends
  // up to 20 songs like the last entry that are not already queued. One request at a time; a last
  // entry that added nothing is not asked again for a minute. Returns the request, if one started.
  topUp(now = Date.now()): Promise<unknown> | null {
    const station = this.station; const client = this.shell.client(); const player = this.shell.player();
    if (!station || station.topping || !client || player.engine !== 'ready' || player.currentIndex < 0) return null;
    if (player.queue.length - 1 - player.currentIndex > 3 || player.queue.length >= this.limit) return null;
    const last = player.queue.at(-1); const entry = player.entryIds.at(-1);
    if (!last || !entry || last.source !== 'navidrome') return null;
    if (station.tried?.entry === entry && now - station.tried.at < 60_000) return null;
    station.topping = true; station.tried = { entry, at: now };
    const radio = this;
    const task = Effect.gen(function* () {
      const similar = yield* client.similarSongs(last.id, 30);
      if (radio.station?.generation !== station.generation || radio.shell.client() !== client) return;
      const queue = radio.shell.player().queue;
      const queued = new Set(queue.map(track => track.id));
      const fresh = distinct(similar.filter(track => !queued.has(track.id))).slice(0, Math.min(20, radio.limit - queue.length));
      if (!fresh.length) return;
      radio.shell.remember(fresh);
      yield* radio.shell.append(client, fresh);
    });
    return this.shell.background(task).finally(() => { station.topping = false; });
  }
}
