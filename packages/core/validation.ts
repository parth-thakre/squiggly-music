import { Schema } from 'effect';

// Keep runtime schemas out of renderer imports. UI contracts are type-only.
export const CommandSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('play', 'pause', 'stop', 'next', 'previous', 'restart') }),
  Schema.Struct({ type: Schema.Literal('seek'), seconds: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()) }),
  Schema.Struct({ type: Schema.Literal('volume'), percent: Schema.Number.pipe(Schema.finite(), Schema.between(0, 100)) }),
  Schema.Struct({ type: Schema.Literal('select'), id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)) }),
  Schema.Struct({ type: Schema.Literal('device'), id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)) }),
);
export const ConnectionSchema = Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(2048)),
  username: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  password: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
});
