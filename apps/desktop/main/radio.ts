import { Effect } from 'effect';
import { AUTOPLAY_ASK, AUTOPLAY_SONGS, autoplayTurn, fallbackAsks, freshSongs, keepQueued, nearEnd, noAutoplay } from '../../../packages/core/autoplay';
import type { AlbumDetail, AutoplayView, PlayerSnapshot, RadioSeed, RandomSongOptions, Track } from '../../../packages/core/contracts';

export interface RadioClient {
  topSongs(artistId: string, count: number): Effect.Effect<Track[], Error>;
  album(id: string): Effect.Effect<AlbumDetail, Error>;
  similarSongs(id: string, count: number): Effect.Effect<Track[], Error>;
  randomSongs(options: RandomSongOptions): Effect.Effect<Track[], Error>;
}
export interface RadioShell<C extends RadioClient> {
  client(): C | null;
  player(): PlayerSnapshot;
  known(id: string): Track | undefined;
  // Adds tracks to the main process's bounded known-track map.
  remember(tracks: readonly Track[]): void;
  replace(client: C, tracks: Track[]): Effect.Effect<void, Error>;
  // Keeps the current entry playing and puts tracks after it in place of the rest of the queue.
  follow(client: C, tracks: Track[]): Effect.Effect<void, Error>;
  append(client: C, tracks: Track[]): Effect.Effect<void, Error>;
  // Runs a background top-up (a bounded lane, with metrics).
  background(task: Effect.Effect<void, Error>): Promise<unknown>;
  changed(): void;
  // Whether autoplay may add songs now: on in Settings, and no sleep timer waiting for this song
  // to end (its listener wants the music to stop there).
  autoplay(): boolean;
  // Moves on to the next song (Next, held while autoplay was finding it one), if `still` says so
  // when the engine takes it: other commands can be waiting ahead of it. False when it wasn't taken.
  next(still: () => boolean): boolean;
}
type HeldNext = { turn: number; generation: number; entry: string };
const distinct = (tracks: readonly Track[]) => [...new Map(tracks.map(track => [track.id, track])).values()];

// Radio lives in the main process, not in a window, so it keeps topping up while every window
// is hidden. Each station has a generation. Starting a station or any other playback bumps the
// counter, so a start or top-up that finishes late never touches a newer queue. Autoplay
// (packages/core/autoplay.ts) is the same machinery for an ordinary queue: it adds songs like the
// last one once that is playing, under the same counter.
export class Radio<C extends RadioClient> {
  private generation = 0;
  private station: { generation: number; view: { label: string }; topping: boolean; tried: { entry: string; at: number } | null } | null = null;
  private autoplaying = false;
  private autoplayTried: { entry: string; at: number } | null = null;
  // Next was pressed on the last song while a turn was out: it moves on from that entry once the
  // songs are in. Only that turn's songs take it, and any other playback lets go of it.
  private held: HeldNext | null = null;
  private turns = 0;
  private autoplayed: AutoplayView = noAutoplay;
  // Songs appended and not yet seen in a snapshot: the audio host names their entries, and its
  // reply can come before the snapshot that shows them.
  private marking: { before: Set<string>; ids: Set<string> } | null = null;
  constructor(private shell: RadioShell<C>, private limit = 1000) {}

  get view(): { label: string } | null { return this.station?.view ?? null; }
  get autoplayView(): AutoplayView { return this.autoplayed; }
  // Next on the queue's last song while a turn is finding what follows it: true when this holds the
  // press until the songs are in, rather than the engine refusing it. Repeat or radio, or no turn
  // out, leave it to the engine.
  holdNext(): boolean {
    const player = this.shell.player(); const entry = player.entryIds[player.currentIndex];
    if (!this.autoplaying || this.station || !this.shell.autoplay() || player.repeat !== 'off' || !entry || player.currentIndex !== player.queue.length - 1) return false;
    this.held = { turn: this.turns, generation: this.generation, entry };
    return true;
  }
  // Previous, pause, a jump, or any other playback command from the listener: a held Next is let go.
  letGo() { this.held = null; }
  // A held Next still stands: nothing let go of it, the queue is the same, and its entry still plays.
  private holds(held: HeldNext) {
    const player = this.shell.player();
    return this.held === held && held.generation === this.generation && !this.station && player.repeat === 'off'
      && player.entryIds[player.currentIndex] === held.entry;
  }

  // Called with every host snapshot before it is published. Finds the entries autoplay's last
  // songs became, and forgets entries that have left the queue. Returns the view to publish.
  observe(player: Pick<PlayerSnapshot, 'queue' | 'entryIds'>): AutoplayView {
    const marking = this.marking;
    if (marking) {
      const added = player.entryIds.filter((entry, i) => !marking.before.has(entry) && marking.ids.has(player.queue[i]?.id));
      if (added.length) { this.marking = null; this.autoplayed = { ...this.autoplayed, added: [...this.autoplayed.added, ...added] }; }
    }
    return this.autoplayed = keepQueued(this.autoplayed, player.entryIds);
  }

  // Call just before any other playback replaces the queue, and when the engine or session goes away.
  end() {
    this.generation++; this.held = null;
    if (this.station) { this.station = null; this.shell.changed(); }
  }

  // Asking the server for songs like an artist can take over ten seconds, so artist and record
  // radio start from a song: an artist's top song, or a record's first track. Succeeds with
  // whether the station began: false when other playback took over while the queue was replaced.
  start(seed: RadioSeed): Effect.Effect<boolean, Error> {
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
      // Radio from the song that's playing carries on from it rather than starting it over.
      const player = radio.shell.player();
      if (player.queue[player.currentIndex]?.id === start.id) yield* radio.shell.follow(client, tracks.slice(1));
      else yield* radio.shell.replace(client, tracks);
      if (generation !== radio.generation) return false;
      radio.station = { generation, view: { label: seed.label }, topping: false, tried: null };
      radio.shell.changed();
      return true;
    });
  }

  // Called for every player snapshot. When three or fewer entries follow the current one, appends
  // up to 20 songs like the last entry that are not already queued. One request at a time; a last
  // entry that added nothing is not asked again for a minute. Returns the request, if one started.
  // Without a station, autoplay takes the snapshot instead.
  topUp(now = Date.now()): Promise<unknown> | null {
    const station = this.station; const client = this.shell.client(); const player = this.shell.player();
    if (!station) return this.autoplay(now);
    if (station.topping || !client || player.engine !== 'ready' || player.currentIndex < 0) return null;
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

  // Once the queue's last entry or the one before it plays, appends up to ten songs like it that are not queued, asking
  // about the songs before it too when its own don't make ten. One turn at a time. A turn that
  // failed is not tried again for a minute; one that found nothing new is not tried again for that
  // entry, and the view says so. An answer is dropped if, meanwhile, other playback began, the
  // queue gained another last entry or moved off it or finished, repeat or radio started, or
  // autoplay was turned off or held.
  private autoplay(now: number): Promise<unknown> | null {
    const client = this.shell.client(); const player = this.shell.player();
    if (this.autoplaying || !client || player.engine !== 'ready' || player.queue.length >= this.limit || !this.shell.autoplay()) return null;
    const turn = autoplayTurn({ queue: player.queue, entryIds: player.entryIds, index: player.currentIndex, repeat: player.repeat, radio: false });
    if (!turn || this.autoplayed.missed === turn.entry) return null;
    if (this.autoplayTried?.entry === turn.entry && now - this.autoplayTried.at < 60_000) return null;
    this.autoplaying = true; this.autoplayTried = { entry: turn.entry, at: now };
    const radio = this; const generation = this.generation; const mine = ++this.turns;
    let moving = false;
    const current = () => {
      const latest = radio.shell.player();
      return generation === radio.generation && !radio.station && radio.shell.client() === client && radio.shell.autoplay()
        && latest.repeat === 'off' && nearEnd(latest.currentIndex, latest.queue.length) && latest.entryIds.at(-1) === turn.entry;
    };
    const task = Effect.gen(function* () {
      const taken = new Set(radio.shell.player().queue.map(track => track.id));
      const room = Math.min(AUTOPLAY_SONGS, radio.limit - radio.shell.player().queue.length);
      const fresh: Track[] = [];
      for (const seed of turn.seeds) {
        if (fresh.length >= room) break;
        const similar = yield* client.similarSongs(seed.id, AUTOPLAY_ASK);
        if (!current()) return;
        fresh.push(...freshSongs(similar, taken, room - fresh.length));
      }
      for (const ask of fallbackAsks(turn.seeds[0])) {
        if (fresh.length) break;
        const random = yield* client.randomSongs(ask);
        if (!current()) return;
        fresh.push(...freshSongs(random, taken, room));
      }
      // Songs queued by hand while the server answered aren't added again.
      const latest = radio.shell.player();
      const queued = new Set(latest.queue.map(track => track.id));
      const adding = fresh.filter(track => !queued.has(track.id)).slice(0, radio.limit - latest.queue.length);
      if (!adding.length) { radio.autoplayed = { ...radio.autoplayed, missed: turn.entry }; radio.shell.changed(); return; }
      radio.shell.remember(adding);
      radio.marking = { before: new Set(latest.entryIds), ids: new Set(adding.map(track => track.id)) };
      yield* radio.shell.append(client, adding).pipe(Effect.tapError(() => Effect.sync(() => { radio.marking = null; })));
      // Next was held for these: on to the first of them, if it still stands when the engine takes it.
      const held = radio.held;
      if (held?.turn === mine && radio.holds(held)) {
        moving = radio.shell.next(() => { const still = radio.holds(held); if (radio.held === held) radio.held = null; return still; });
      }
    });
    return this.shell.background(task).finally(() => { this.autoplaying = false; if (!moving && this.held?.turn === mine) this.held = null; });
  }
}
