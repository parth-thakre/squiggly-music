import { Effect, Either, Schema } from 'effect';
import { PlayReports, type QueuedPlays, type SendOutcome } from '../../../packages/core/plays';
import { QueuedPlaysSchema } from '../../../packages/core/validation';
import { reachOf, type SubsonicClient } from '../../../packages/adapter-opensubsonic/client';

// Play reports on Android, with finished plays kept in localStorage (squiggly.plays) while the
// server is out of reach, and sent in order when it answers again. Invalid data is dropped.
const KEY = 'squiggly.plays';
function load(): QueuedPlays {
  try {
    const decoded = Schema.decodeUnknownEither(QueuedPlaysSchema)(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    if (Either.isRight(decoded)) return { account: decoded.right.account, plays: decoded.right.plays };
  } catch { /* Nothing kept. */ }
  return { account: null, plays: [] };
}
export function createPlays(deps: { client(): SubsonicClient | null; away(): boolean; failed(): void; changed(count: number): void }) {
  return new PlayReports({
    async send(trackId, event, at): Promise<SendOutcome> {
      const client = deps.client();
      if (!client) return 'refused';
      const result = await Effect.runPromise(Effect.either(client.reportPlay(trackId, event, at)));
      return Either.isRight(result) ? 'sent' : reachOf(result.left);
    },
    away: deps.away, failed: deps.failed, load,
    save: value => { try { localStorage.setItem(KEY, JSON.stringify({ version: 1, account: value.account, plays: value.plays })); } catch { /* Kept for this visit only. */ } },
    changed: deps.changed,
  });
}
