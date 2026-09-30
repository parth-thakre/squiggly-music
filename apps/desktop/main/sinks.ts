import { execFile } from 'node:child_process';
import { Either, Schema } from 'effect';
import type { AudioPath, AudioSink, PlayerSnapshot, SinkRoute } from '../../../packages/core/contracts';
import {
  PactlInfoSchema, PactlSinkInputSchema, PactlSinkSchema, PwClientSchema, PwLinkSchema, PwMetadataSchema, PwNodeSchema, PwTargetSchema,
} from '../../../packages/core/desktopValidation';
import { parseSampleSpec, sinkFormat, sinkResamples } from '../../../packages/core/sinks';

// The sink line (AudioPath.sink): what the Linux sound server says the sink mpv plays into runs
// at. PipeWire answers through `pw-dump`; without it, `pactl -f json` answers for PulseAudio or
// pipewire-pulse. Either may be missing, and then the line stays blank. The answer is the
// server's report about its sink, never what a DAC receives. See docs/audio.md.

export const PROBE_TIMEOUT_MS = 2000;
// While playing, the sink is asked again this often. Changes (another song, another output
// format) ask sooner, but never within PROBE_GAP_MS of the last time.
export const PROBE_EVERY_MS = 10_000;
export const PROBE_GAP_MS = 3000;

export interface SinkQuery {
  // The audio host's process id, which owns mpv's stream.
  pid: number | undefined;
  // mpv's current-ao and audio-device.
  backend: string | null;
  device: string;
}
export type SinkFacts = Omit<AudioSink, 'resampling'>;
// Runs a tool and gives its standard output, or null when it is missing, fails, or takes too long.
export type Run = (file: string, args: string[]) => Promise<string | null>;

// mpv outputs that can reach a sound server. Only pipewire and pulse name a sink themselves; the
// others are found by their stream alone, and direct ALSA use has none, so it stays unknown.
const PROBED = new Set(['pipewire', 'pulse', 'alsa', 'jack']);
const NAMED = new Set(['pipewire', 'pulse']);
const probeable = (backend: string | null): backend is string => backend !== null && PROBED.has(backend);

export const execText = (file: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string | null> => new Promise(resolve => {
  try {
    // A dump of a busy desktop passes Node's default 1 MiB. C locale keeps numbers in the JSON plain.
    execFile(file, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => resolve(error ? null : stdout));
  } catch { resolve(null); }
});

function jsonArray(text: string | null): unknown[] | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch { return null; }
}
const decodeEach = <A, I>(schema: Schema.Schema<A, I>, items: readonly unknown[]) => items.flatMap(item => {
  const decoded = Schema.decodeUnknownEither(schema)(item);
  return Either.isRight(decoded) ? [decoded.right] : [];
});
const typeOf = (item: unknown) => typeof item === 'object' && item !== null && 'type' in item ? item.type : null;

// PipeWire ------------------------------------------------------------------------------
type PwNode = Schema.Schema.Type<typeof PwNodeSchema>;
export interface PwDump {
  nodes: Map<number, PwNode>;
  // Output node id to the input node ids it links to.
  links: Map<number, Set<number>>;
  clientPids: Map<number, number>;
  // The node name WirePlumber has chosen as the default sink (default.audio.sink). Not
  // default.configured.audio.sink, which may name a sink that isn't there.
  defaultSink: string | null;
}
// Null when the text is not a dump: not JSON, not an array, or no node in it (a running
// PipeWire always lists its driver nodes).
export function parsePwDump(text: string | null): PwDump | null {
  const items = jsonArray(text);
  if (!items) return null;
  const dump: PwDump = { nodes: new Map(), links: new Map(), clientPids: new Map(), defaultSink: null };
  for (const node of decodeEach(PwNodeSchema, items.filter(item => typeOf(item) === 'PipeWire:Interface:Node'))) dump.nodes.set(node.id, node);
  if (!dump.nodes.size) return null;
  for (const link of decodeEach(PwLinkSchema, items.filter(item => typeOf(item) === 'PipeWire:Interface:Link'))) {
    const targets = dump.links.get(link.info['output-node-id']) ?? new Set();
    dump.links.set(link.info['output-node-id'], targets.add(link.info['input-node-id']));
  }
  for (const client of decodeEach(PwClientSchema, items.filter(item => typeOf(item) === 'PipeWire:Interface:Client'))) {
    const pid = client.info.props['application.process.id'];
    if (pid) dump.clientPids.set(client.id, pid);
  }
  for (const metadata of decodeEach(PwMetadataSchema, items.filter(item => typeOf(item) === 'PipeWire:Interface:Metadata'))) {
    if (metadata.props['metadata.name'] !== 'default') continue;
    const entry = metadata.metadata?.find(item => item.key === 'default.audio.sink');
    const target = entry && Schema.decodeUnknownEither(PwTargetSchema)(entry.value);
    if (target && Either.isRight(target)) dump.defaultSink = target.right.name;
  }
  return dump;
}

const isSink = (node: PwNode | undefined): node is PwNode => node?.info.props['media.class'] === 'Audio/Sink';
function pipewireFacts(node: PwNode, route: SinkRoute): SinkFacts | null {
  const name = node.info.props['node.description'] || node.info.props['node.name'];
  if (!name) return null;
  // A suspended sink has no Format, so its rate and format are unknown, not its old ones.
  const format = node.info.params?.Format?.[0];
  return { server: 'pipewire', route, name, rate: format?.rate ?? null, format: sinkFormat(format?.format), channels: format?.channels ?? null };
}
// The device mpv was told to use: pipewire/<node.name> or pulse/<node.name>, or null for the default.
const namedDevice = (device: string) => /^(?:pipewire|pulse)\/(.+)$/.exec(device)?.[1] ?? null;
const usesDefault = (device: string) => device === 'auto' || device === 'pipewire' || device === 'pulse';

// mpv's own streams in the graph: the host's process id, on the node or on its client.
export function mpvStreams(dump: PwDump, pid: number | undefined): PwNode[] {
  if (pid === undefined) return [];
  return [...dump.nodes.values()].filter(node => {
    const props = node.info.props;
    if (props['media.class'] !== 'Stream/Output/Audio') return false;
    const client = props['client.id'];
    return props['application.process.id'] === pid || (client !== undefined && dump.clientPids.get(client) === pid);
  });
}

// Finds the sink by following mpv's own stream to the sink it is linked to. Without a stream, a
// pipewire output falls back to the device mpv asked for, then to the default sink; either may be
// a guess, since the session manager can move a stream elsewhere. Other outputs may not be talking
// to this PipeWire at all, so without a stream they are unknown here. A stream linked to no sink,
// or to several, is unknown.
export function pipewireSink(dump: PwDump, query: SinkQuery): SinkFacts | null {
  if (!probeable(query.backend)) return null;
  const streams = mpvStreams(dump, query.pid);
  if (streams.length) {
    const sinks = new Set<number>();
    for (const stream of streams) for (const target of dump.links.get(stream.id) ?? []) if (isSink(dump.nodes.get(target))) sinks.add(target);
    return sinks.size === 1 ? pipewireFacts(dump.nodes.get([...sinks][0])!, 'stream') : null;
  }
  if (query.backend !== 'pipewire') return null;
  const device = namedDevice(query.device);
  const name = device ?? (usesDefault(query.device) ? dump.defaultSink : null);
  const sink = name === null ? undefined : [...dump.nodes.values()].find(node => isSink(node) && node.info.props['node.name'] === name);
  return sink ? pipewireFacts(sink, device === null ? 'default' : 'device') : null;
}

// PulseAudio (or pipewire-pulse without pw-dump) --------------------------------------------
type PactlSink = Schema.Schema.Type<typeof PactlSinkSchema>;
type PactlSinkInput = Schema.Schema.Type<typeof PactlSinkInputSchema>;
export const parsePactlSinks = (text: string | null) => { const items = jsonArray(text); return items && decodeEach(PactlSinkSchema, items); };
export const parsePactlSinkInputs = (text: string | null) => { const items = jsonArray(text); return items && decodeEach(PactlSinkInputSchema, items); };
export function parsePactlInfo(text: string | null) {
  if (!text) return null;
  try { return Either.getOrNull(Schema.decodeUnknownEither(PactlInfoSchema)(JSON.parse(text))); } catch { return null; }
}
function pulseFacts(sink: PactlSink, route: SinkRoute): SinkFacts | null {
  const name = sink.description || sink.name;
  if (!name) return null;
  // pipewire-pulse answers for PipeWire, and says so as the sink's driver.
  return { server: sink.driver === 'PipeWire' ? 'pipewire' : 'pulseaudio', route, name, ...parseSampleSpec(sink.sample_specification ?? '') };
}
// The same order as PipeWire's: mpv's own sink-input by process id, then the device, then the
// default sink, which is asked for only when it's needed. The last two are guesses and say so.
export async function pulseSink(sinks: readonly PactlSink[], inputs: readonly PactlSinkInput[], query: SinkQuery, defaultSink: () => Promise<string | null>): Promise<SinkFacts | null> {
  if (!probeable(query.backend)) return null;
  const pid = query.pid === undefined ? null : String(query.pid);
  const input = pid === null ? undefined : inputs.find(item => item.properties?.['application.process.id'] === pid);
  if (input) { const sink = sinks.find(item => item.index === input.sink); return sink ? pulseFacts(sink, 'stream') : null; }
  if (!NAMED.has(query.backend)) return null;
  const device = namedDevice(query.device);
  const name = device ?? (usesDefault(query.device) ? await defaultSink() : null);
  const sink = name === null ? undefined : sinks.find(item => item.name === name);
  return sink ? pulseFacts(sink, device === null ? 'default' : 'device') : null;
}

// Asks the sound server once. Linux only, and only for an mpv output that can reach one; nothing is
// spawned otherwise. For ao=pipewire a dump from pw-dump settles it, even when it finds no sink.
// Other outputs may talk to another server (PulseAudio beside a PipeWire kept for screen sharing,
// or PULSE_SERVER set elsewhere), so the dump settles them only when mpv's stream is in it. Then,
// or when pw-dump is missing or doesn't answer, pactl is asked. Never throws.
export async function readSink(query: SinkQuery, run: Run = execText, platform: string = process.platform): Promise<SinkFacts | null> {
  if (platform !== 'linux' || !probeable(query.backend)) return null;
  try {
    const dump = parsePwDump(await run('pw-dump', ['-N']));
    if (dump && (query.backend === 'pipewire' || mpvStreams(dump, query.pid).length)) return pipewireSink(dump, query);
    const [sinksText, inputsText] = await Promise.all([run('pactl', ['-f', 'json', 'list', 'sinks']), run('pactl', ['-f', 'json', 'list', 'sink-inputs'])]);
    const sinks = parsePactlSinks(sinksText);
    if (!sinks?.length) return null;
    return await pulseSink(sinks, parsePactlSinkInputs(inputsText) ?? [], query,
      async () => parsePactlInfo(await run('pactl', ['-f', 'json', 'info']))?.default_sink_name ?? null);
  } catch { return null; }
}

// Keeps the sink reading current without asking the server more than it must: when a song starts
// or mpv's output changes, and every PROBE_EVERY_MS while playing, never within PROBE_GAP_MS of the
// last ask, and one ask at a time. It has no timers; the audio host's snapshots (every 250 ms)
// drive it through observe().
export class SinkWatch {
  private reading: { valid: string; sink: SinkFacts } | null = null;
  private want: string | null = null;
  private pending = false;
  private retried = false;
  private busy = false;
  private startedAt = -Infinity;
  private epoch = 0;
  private query: SinkQuery | null = null;
  private platform: string;

  constructor(private probe: (query: SinkQuery) => Promise<SinkFacts | null>, private options: { platform?: string; record?: (ms: number, failed: boolean) => void } = {}) {
    this.platform = options.platform ?? process.platform;
  }

  // `pid` is the audio host's process id.
  observe(player: PlayerSnapshot, pid: number | undefined) {
    if (this.platform !== 'linux') return;
    const audio = player.audio;
    if (player.engine !== 'ready' || player.currentIndex < 0 || !probeable(audio.outputBackend)) { this.reset(); return; }
    const now = Date.now();
    const valid = validKey(audio);
    const want = `${player.playId}|${valid}`;
    if (want !== this.want) { this.want = want; this.pending = true; this.retried = false; }
    else if (player.playing && now - this.startedAt >= PROBE_EVERY_MS) this.pending = true;
    this.query = { pid, backend: audio.outputBackend, device: audio.requestedDevice };
    if (this.pending && !this.busy && now - this.startedAt >= PROBE_GAP_MS) this.start(now, valid, this.query);
  }
  // The reading for this output, with resampling worked out against mpv's output rate now (unknown
  // for a guessed sink). Null when there's none, or when mpv's output has changed since the server
  // was asked.
  view(audio: AudioPath): AudioSink | null {
    const sink = this.reading?.valid === validKey(audio) ? this.reading.sink : null;
    return sink && { ...sink, resampling: sinkResamples(sink, audio.outputRate) };
  }
  // Forgets the reading. An answer still on its way is dropped.
  reset() {
    this.epoch++; this.reading = null; this.want = null; this.pending = false; this.query = null;
  }

  private start(now: number, valid: string, query: SinkQuery) {
    this.pending = false; this.startedAt = now; this.busy = true;
    const epoch = this.epoch;
    const began = performance.now();
    void this.probe(query).then(sink => ({ sink, failed: false }), () => ({ sink: null, failed: true })).then(({ sink, failed }) => {
      this.busy = false;
      this.options.record?.(performance.now() - began, failed);
      if (epoch !== this.epoch) return;
      // No answer is unknown, not the last answer. The first ask for a song may land before the
      // server has linked mpv's new stream, so when it finds no sink, or only guesses at one from
      // the device or the default, it is asked again after the gap.
      this.reading = sink ? { valid, sink } : null;
      if (sink?.route !== 'stream' && !this.retried) { this.retried = true; this.pending = true; }
    });
  }
}
// The output a reading describes. A reading stays valid across songs while these stay the same.
const validKey = (audio: AudioPath) => [audio.outputBackend, audio.outputRate, audio.outputFormat, audio.outputChannels, audio.requestedDevice].join('|');
