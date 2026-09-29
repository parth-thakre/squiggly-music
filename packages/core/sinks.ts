import type { AudioServer, AudioSink } from './contracts';

// Words for the sound server's report about its sink (AudioPath.sink). Pure, so the renderer and
// the main process share them. The report is what the server says it opened the sink with, never
// what a DAC receives, so nothing here claims anything about the hardware.

export const serverName = (server: AudioServer) => server === 'pipewire' ? 'PipeWire' : 'PulseAudio';

// True only when both rates are known and differ; null when either is unknown.
export function sinkResampling(sinkRate: number | null, outputRate: number | null): boolean | null {
  if (!sinkRate || !outputRate) return null;
  return sinkRate !== outputRate;
}

// A server's sample format name in one spelling: PipeWire's S32LE and S24_32LE, PulseAudio's
// s32le and float32le. Unknown or empty stays unknown.
export function sinkFormat(raw: string | null | undefined): string | null {
  const format = raw?.trim().toLowerCase().replaceAll('_', '-');
  if (!format || format === 'unknown' || !/^[a-z0-9-]{1,32}$/.test(format)) return null;
  return format.startsWith('float32') ? `f32${format.slice(7)}` : format;
}

// PulseAudio's sample specification, `s16le 2ch 44100Hz`. Anything else gives nulls.
export function parseSampleSpec(spec: string): { format: string | null; channels: number | null; rate: number | null } {
  const match = /^([a-z0-9_-]+) (\d{1,3})ch (\d{1,7})Hz$/i.exec(spec.trim());
  if (!match) return { format: null, channels: null, rate: null };
  const channels = Number(match[2]), rate = Number(match[3]);
  return { format: sinkFormat(match[1]), channels: channels >= 1 && channels <= 256 ? channels : null, rate: rate > 0 ? rate : null };
}

// s32le reads as s32 and s24-32le as s24-32; big-endian formats keep their be.
export const showFormat = (format: string) => format.replace(/le$/, '');
const kHz = (rate: number) => `${(rate / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz`;

// Whether the server resamples what mpv sends through this sink. Null for a sink that was only
// guessed at, since mpv's stream may be playing into another.
export const sinkResamples = (sink: Omit<AudioSink, 'resampling'>, outputRate: number | null) =>
  sink.route === 'stream' ? sinkResampling(sink.rate, outputRate) : null;

// The Diagnostics page's sink row: what the server runs the sink at, against what mpv sends.
// "Matches" means the two rates are equal, nothing more. A guessed sink says it is one and
// compares nothing.
export function sinkSentence(sink: AudioSink, outputRate: number | null): string {
  const server = serverName(sink.server);
  const which = sink.route === 'device' ? 'the sink mpv asked for' : sink.route === 'default' ? 'the default sink' : 'the sink';
  const guess = 'mpv\'s stream wasn\'t found, so it may be playing into another sink';
  if (!sink.rate) return sink.route === 'stream' ? `${server} didn't report what the sink runs at.` : `${server} didn't report what ${which} runs at, and ${guess}.`;
  const runs = `${server} runs ${which} at ${[kHz(sink.rate), sink.format && showFormat(sink.format)].filter(Boolean).join(', ')}`;
  if (sink.route !== 'stream') return `${runs}. Whether ${server} resamples isn't known: ${guess}.`;
  const resampling = sinkResampling(sink.rate, outputRate);
  if (resampling === null) return `${runs}. The rate mpv sends isn't known.`;
  return resampling ? `${runs}; mpv sends ${kHz(outputRate!)}, so ${server} resamples.` : `${runs}, which matches the rate mpv sends.`;
}

// The deck's note, only when the server resamples what mpv sends through the sink its stream is linked to.
export const resampledNote = (sink: AudioSink | null | undefined) =>
  sink?.resampling === true && sink.route === 'stream' ? `Resampled by ${serverName(sink.server)}.` : null;
