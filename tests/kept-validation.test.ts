import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Either, Schema } from 'effect';
import { KeptContainerSchema, KeptCoverSchema, KeptIndexShapeSchema, KeptSongSchema } from '../packages/core/keptValidation';
import { KEPT_FILE } from '../packages/core/kept';

// The kept index's shape on disk. The same file shape is written by the Android app (Kept.kt),
// so this fixture documents both.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/kept-index.json'), 'utf8'));
const ok = (schema: Schema.Schema<any, any>, value: unknown) => Either.isRight(Schema.decodeUnknownEither(schema)(value));

describe('the kept index on disk', () => {
  it('accepts the documented shape, entry by entry', () => {
    expect(ok(KeptIndexShapeSchema, fixture)).toBe(true);
    for (const song of Object.values(fixture.songs)) expect(ok(KeptSongSchema, song)).toBe(true);
    for (const container of fixture.containers) expect(ok(KeptContainerSchema, container)).toBe(true);
    for (const cover of Object.values(fixture.covers)) expect(ok(KeptCoverSchema, cover)).toBe(true);
    for (const entry of [...Object.values(fixture.songs), ...Object.values(fixture.covers)] as { file: string }[]) expect(KEPT_FILE.test(entry.file)).toBe(true);
  });
  it('refuses what the app never writes', () => {
    const song = fixture.songs['tr-1-1'];
    expect(ok(KeptIndexShapeSchema, { ...fixture, version: 2 })).toBe(false);
    expect(ok(KeptIndexShapeSchema, { ...fixture, containers: Array(2001).fill(fixture.containers[0]) })).toBe(false);
    expect(ok(KeptSongSchema, { ...song, track: { ...song.track, source: 'local' } })).toBe(false);
    expect(ok(KeptSongSchema, { ...song, bytes: -1 })).toBe(false);
    expect(ok(KeptContainerSchema, { ...fixture.containers[0], kind: 'artist' })).toBe(false);
    expect(ok(KeptContainerSchema, { ...fixture.containers[0], trackIds: Array(5001).fill('t') })).toBe(false);
    expect(ok(KeptCoverSchema, { ...fixture.covers['al-1'], type: 'image/svg+xml' })).toBe(false);
    for (const file of ['../x', 's-XYZ.flac', 'index.json', 's-0123456789abcdef0123456789abcdef.flac/../../x', 'S-0123456789ABCDEF0123456789ABCDEF.flac']) expect(KEPT_FILE.test(file)).toBe(false);
  });
});
