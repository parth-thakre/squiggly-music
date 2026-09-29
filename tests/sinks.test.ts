import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAudio, emptyPlayer, type AudioPath, type AudioSink, type PlayerSnapshot } from '../packages/core/contracts';
import { parseSampleSpec, resampledNote, sinkFormat, sinkResamples, sinkResampling, sinkSentence } from '../packages/core/sinks';
import {
  execText, parsePactlSinks, parsePwDump, pipewireSink, PROBE_EVERY_MS, PROBE_GAP_MS, readSink, SinkWatch,
  type Run, type SinkFacts, type SinkQuery,
} from '../apps/desktop/main/sinks';
import {
  BLUETOOTH, client, defaults, driverNodes, HOST_PID, link, mpvStream, pactlInfo, pactlInputs, pactlSinks, pwDump, SECRET, SINK, SINK_DESCRIPTION, sinkNode, text,
} from './sinkFixtures';

const dac: SinkFacts = { server: 'pipewire', route: 'stream', name: SINK_DESCRIPTION, rate: 48000, format: 's32le', channels: 2 };
// The same sink when mpv's stream wasn't found: a guess from the device or the default.
const guessed = (route: SinkFacts['route']): SinkFacts => ({ ...dac, route });
const query = (patch: Partial<SinkQuery> = {}): SinkQuery => ({ pid: HOST_PID, backend: 'pipewire', device: 'auto', ...patch });
const dump = (parts?: Parameters<typeof pwDump>[0]) => parsePwDump(text(pwDump(parts)))!;

// A fake shell: answers by tool, and records every call.
function shell(answers: { pwDump?: string | null; sinks?: string | null; inputs?: string | null; info?: string | null }) {
  const calls: string[] = [];
  const run: Run = async (file, args) => {
    const call = [file, ...args].join(' ');
    calls.push(call);
    if (file === 'pw-dump') return answers.pwDump ?? null;
    if (call.endsWith('list sinks')) return answers.sinks ?? null;
    if (call.endsWith('list sink-inputs')) return answers.inputs ?? null;
    if (call.endsWith('info')) return answers.info ?? null;
    return null;
  };
  return { run, calls };
}

describe('the PipeWire sink', () => {
  it('follows mpv\'s stream, found through its client\'s process id, to the sink it is linked to', () => {
    expect(pipewireSink(dump(), query())).toEqual(dac);
  });

  it('takes the sink the stream is linked to over the device and the default', () => {
    const moved = dump({ replace: { 170: link(170, 130, 160), 171: link(171, 130, 160) } });
    const headphones = { server: 'pipewire', route: 'stream', name: 'Headphones', rate: 44100, format: 's16le', channels: 2 };
    expect(pipewireSink(moved, query())).toEqual(headphones);
    expect(pipewireSink(moved, query({ device: `pipewire/${SINK}` }))).toEqual(headphones);
  });

  it('finds a pulse stream by the process id on the node itself', () => {
    const pulse = dump({ without: 'stream', extra: [client(185, 999), mpvStream(130, { clientId: 185, pid: HOST_PID }), link(170, 130, 160)] });
    expect(pipewireSink(pulse, query({ backend: 'pulse' }))?.name).toBe('Headphones');
  });

  it('without a stream, uses the device mpv was given, then the default sink', () => {
    const none = dump({ without: 'stream' });
    expect(pipewireSink(none, query({ device: `pipewire/${BLUETOOTH}` }))).toMatchObject({ name: 'Headphones', route: 'device' });
    expect(pipewireSink(none, query({ device: `pulse/${BLUETOOTH}` }))).toMatchObject({ name: 'Headphones', route: 'device' });
    // ao=pulse may be talking to another server, so this graph's device and default say nothing about it.
    expect(pipewireSink(none, query({ backend: 'pulse', device: `pulse/${BLUETOOTH}` }))).toBeNull();
    expect(pipewireSink(none, query({ backend: 'pulse' }))).toBeNull();
    expect(pipewireSink(none, query({ device: 'pipewire/alsa_output.gone' }))).toBeNull();
    // The default is default.audio.sink, never default.configured.audio.sink (a sink that isn't there).
    expect(pipewireSink(none, query({ device: 'auto' }))).toEqual(guessed('default'));
    expect(pipewireSink(none, query({ pid: undefined, device: 'pipewire' }))).toEqual(guessed('default'));
    expect(pipewireSink(dump({ without: 'stream', replace: { 40: defaults(BLUETOOTH) } }), query())).toMatchObject({ name: 'Headphones', route: 'default' });
    expect(pipewireSink(dump({ without: 'stream', replace: { 40: defaults(null) } }), query())).toBeNull();
    // A device that isn't mpv's pipewire or pulse name says nothing about a sink.
    expect(pipewireSink(none, query({ device: 'alsa/hdmi:CARD=HDMI,DEV=0' }))).toBeNull();
  });

  it('reads a default given as JSON text', () => {
    const textDefault = { ...defaults(), metadata: [{ subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: JSON.stringify({ name: BLUETOOTH }) }] };
    expect(pipewireSink(dump({ without: 'stream', replace: { 40: textDefault } }), query())?.name).toBe('Headphones');
  });

  it('finds ALSA and JACK outputs only by their stream', () => {
    expect(pipewireSink(dump(), query({ backend: 'alsa', device: 'alsa/pipewire' }))).toEqual(dac);
    expect(pipewireSink(dump({ without: 'stream' }), query({ backend: 'alsa', device: 'auto' }))).toBeNull();
    expect(pipewireSink(dump({ without: 'stream' }), query({ backend: 'jack', device: 'auto' }))).toBeNull();
  });

  it('is unknown when the stream reaches no sink, or two', () => {
    const filter = { ...mpvStream(180, { mediaClass: 'Audio/Duplex' }), type: 'PipeWire:Interface:Node' };
    expect(pipewireSink(dump({ extra: [filter], replace: { 170: link(170, 130, 180), 171: link(171, 130, 180) } }), query())).toBeNull();
    expect(pipewireSink(dump({ replace: { 171: link(171, 130, 160) } }), query())).toBeNull();
    // Linked nowhere yet: no guess from the default.
    expect(pipewireSink(dump({ replace: { 170: client(170, 1), 171: client(171, 1) } }), query())).toBeNull();
    // A recorder listening to mpv as well doesn't hide the sink.
    const recorder = { ...mpvStream(190, { mediaClass: 'Stream/Input/Audio', clientId: 60 }) };
    expect(pipewireSink(dump({ extra: [recorder, link(191, 130, 190)] }), query())).toEqual(dac);
  });

  it('keeps a suspended sink\'s name and leaves its format unknown', () => {
    const none = dump({ without: 'stream', replace: { 150: sinkNode(150, SINK, SINK_DESCRIPTION, null) } });
    expect(pipewireSink(none, query())).toEqual({ server: 'pipewire', route: 'default', name: SINK_DESCRIPTION, rate: null, format: null, channels: null });
  });

  it('names a sink without a description by its node name', () => {
    expect(pipewireSink(dump({ replace: { 150: sinkNode(150, SINK, null) } }), query())?.name).toBe(SINK);
  });

  it('ignores a rate or format of the wrong type rather than guessing', () => {
    const odd = sinkNode(150);
    const format = odd.info.params.Format[0] as Record<string, unknown>;
    format.rate = '48000'; format.format = { default: 'S32LE' };
    expect(pipewireSink(dump({ replace: { 150: odd } }), query())).toEqual({ ...dac, rate: null, format: null });
  });

  it('carries only its six fields, and never the file name in media.name', () => {
    const reading = pipewireSink(dump(), query());
    expect(Object.keys(reading!).sort()).toEqual(['channels', 'format', 'name', 'rate', 'route', 'server']);
    expect(JSON.stringify(reading)).not.toContain(SECRET);
    expect(JSON.stringify(parsePwDump(text(pwDump())))).not.toContain(SECRET);
  });

  it('refuses text that isn\'t a dump', () => {
    for (const bad of ['', 'not json', '{}', '[]', '[1, "two", null]', text([{ type: 'PipeWire:Interface:Link' }]), text(pwDump()).slice(0, 2000), null]) {
      expect(parsePwDump(bad)).toBeNull();
    }
  });

  it('skips one malformed object and reads the rest', () => {
    expect(pipewireSink(dump({ extra: [{ id: 'x', type: 'PipeWire:Interface:Node', info: null }, { type: 'PipeWire:Interface:Client' }] }), query())).toEqual(dac);
  });
});

describe('the PulseAudio sink', () => {
  const answers = (patch: Partial<Record<'sinks' | 'inputs' | 'info', unknown>> = {}) => ({
    pwDump: null, sinks: text(patch.sinks ?? pactlSinks()), inputs: text(patch.inputs ?? pactlInputs()), info: text(patch.info ?? pactlInfo()),
  });

  it('asks pactl when pw-dump is missing, and finds mpv\'s sink-input by process id', async () => {
    const { run, calls } = shell(answers({ inputs: pactlInputs(1) }));
    expect(await readSink(query({ backend: 'pulse' }), run, 'linux')).toEqual({ server: 'pulseaudio', route: 'stream', name: 'Built-in Audio Analog Stereo', rate: 44100, format: 's16le', channels: 2 });
    expect(calls).toEqual(['pw-dump -N', 'pactl -f json list sinks', 'pactl -f json list sink-inputs']);
  });

  it('calls pipewire-pulse\'s sinks PipeWire\'s', async () => {
    const { run } = shell(answers());
    expect(await readSink(query({ backend: 'pulse' }), run, 'linux')).toEqual(dac);
  });

  it('falls back to the device, then to the default sink, which it asks for only then', async () => {
    const byDevice = shell(answers({ inputs: [] }));
    expect(await readSink(query({ backend: 'pulse', device: 'pulse/alsa_output.pci-0000_00_1f.3.analog-stereo' }), byDevice.run, 'linux')).toMatchObject({ server: 'pulseaudio', route: 'device' });
    expect(byDevice.calls).not.toContain('pactl -f json info');
    const byDefault = shell(answers({ inputs: pactlInputs(13880, '1') }));
    expect(await readSink(query({ backend: 'pulse' }), byDefault.run, 'linux')).toEqual(guessed('default'));
    expect(byDefault.calls).toContain('pactl -f json info');
    const noDefault = shell({ ...answers({ inputs: [] }), info: null });
    expect(await readSink(query({ backend: 'pipewire' }), noDefault.run, 'linux')).toBeNull();
  });

  it('reads sample specifications, and leaves what it can\'t read unknown', () => {
    expect(parseSampleSpec('s16le 2ch 44100Hz')).toEqual({ format: 's16le', channels: 2, rate: 44100 });
    expect(parseSampleSpec('float32le 2ch 48000Hz')).toEqual({ format: 'f32le', channels: 2, rate: 48000 });
    expect(parseSampleSpec('s24-32le 6ch 96000Hz')).toEqual({ format: 's24-32le', channels: 6, rate: 96000 });
    expect(parseSampleSpec('Invalid specification')).toEqual({ format: null, channels: null, rate: null });
    expect(parseSampleSpec('s16le 0ch 0Hz')).toEqual({ format: 's16le', channels: null, rate: null });
  });

  it('never carries the sink-input\'s media name, and skips malformed entries', () => {
    expect(parsePactlSinks(text([...pactlSinks(), { index: 'x' }, 7]))).toHaveLength(2);
    expect(parsePactlSinks('Connection failure: Connection refused')).toBeNull();
    expect(JSON.stringify(parsePactlSinks(text(pactlSinks())))).not.toContain('volume');
  });
});

describe('asking the sound server', () => {
  it('stops at pw-dump when it answers, even with no sink found', async () => {
    const found = shell({ pwDump: text(pwDump()) });
    expect(await readSink(query(), found.run, 'linux')).toEqual(dac);
    expect(found.calls).toEqual(['pw-dump -N']);
    const notFound = shell({ pwDump: text(pwDump({ without: 'stream' })), sinks: text(pactlSinks()) });
    expect(await readSink(query({ device: 'pipewire/alsa_output.gone' }), notFound.run, 'linux')).toBeNull();
    expect(notFound.calls).toEqual(['pw-dump -N']);
  });

  it('asks pactl for ao=pulse when mpv\'s stream isn\'t in PipeWire\'s graph', async () => {
    const builtIn = { server: 'pulseaudio', route: 'stream', name: 'Built-in Audio Analog Stereo', rate: 44100, format: 's16le', channels: 2 };
    const pulse = { sinks: text(pactlSinks()), inputs: text(pactlInputs(1)), info: text(pactlInfo()) };
    // PulseAudio plays, and a PipeWire with only its driver nodes runs beside it for screen sharing.
    const drivers = shell({ ...pulse, pwDump: text([...driverNodes()]) });
    expect(await readSink(query({ backend: 'pulse' }), drivers.run, 'linux')).toEqual(builtIn);
    expect(drivers.calls).toEqual(['pw-dump -N', 'pactl -f json list sinks', 'pactl -f json list sink-inputs']);
    // A PipeWire with sinks and a default of its own that mpv isn't talking to (PULSE_SERVER elsewhere).
    const separate = shell({ ...pulse, pwDump: text(pwDump({ without: 'stream' })) });
    expect(await readSink(query({ backend: 'pulse' }), separate.run, 'linux')).toEqual(builtIn);
    // Neither server has mpv's stream and pactl isn't there: unknown, not PipeWire's default.
    const noPactl = shell({ pwDump: text(pwDump({ without: 'stream' })) });
    expect(await readSink(query({ backend: 'pulse' }), noPactl.run, 'linux')).toBeNull();
    // ALSA through PulseAudio's plugin is found by its sink-input the same way.
    const alsa = shell({ ...pulse, pwDump: text([...driverNodes()]) });
    expect(await readSink(query({ backend: 'alsa', device: 'auto' }), alsa.run, 'linux')).toEqual(builtIn);
  });

  it('takes PipeWire\'s answer for ao=pulse when mpv\'s stream is in its graph', async () => {
    const graph = text(pwDump({ without: 'stream', extra: [client(185, 999), mpvStream(130, { clientId: 185, pid: HOST_PID }), link(170, 130, 160)] }));
    const { run, calls } = shell({ pwDump: graph, sinks: text(pactlSinks()), inputs: text(pactlInputs(1)) });
    expect((await readSink(query({ backend: 'pulse' }), run, 'linux'))?.name).toBe('Headphones');
    expect(calls).toEqual(['pw-dump -N']);
    // Present but not linked yet: unknown, and asked again later, not looked up elsewhere.
    const unlinked = text(pwDump({ without: 'stream', extra: [client(185, 999), mpvStream(130, { clientId: 185, pid: HOST_PID })] }));
    const early = shell({ pwDump: unlinked, sinks: text(pactlSinks()), inputs: text(pactlInputs(1)) });
    expect(await readSink(query({ backend: 'pulse' }), early.run, 'linux')).toBeNull();
    expect(early.calls).toEqual(['pw-dump -N']);
  });

  it('falls back to pactl when pw-dump answers with something that isn\'t a dump', async () => {
    for (const bad of ['{}', 'garbage', '[]']) {
      const { run, calls } = shell({ pwDump: bad, sinks: text(pactlSinks()), inputs: text(pactlInputs()) });
      expect(await readSink(query({ backend: 'pulse' }), run, 'linux')).toEqual(dac);
      expect(calls).toHaveLength(3);
    }
  });

  it('is unknown when neither tool answers, or pactl answers nonsense', async () => {
    const neither = shell({});
    expect(await readSink(query(), neither.run, 'linux')).toBeNull();
    expect(neither.calls).toEqual(['pw-dump -N', 'pactl -f json list sinks', 'pactl -f json list sink-inputs']);
    expect(await readSink(query(), shell({ sinks: '{"index":', inputs: '[' }).run, 'linux')).toBeNull();
    expect(await readSink(query(), async () => { throw new Error('spawn failed'); }, 'linux')).toBeNull();
  });

  it('spawns nothing off Linux, or for an output that reaches no sound server', async () => {
    for (const platform of ['win32', 'darwin']) {
      const { run, calls } = shell({ pwDump: text(pwDump()) });
      expect(await readSink(query(), run, platform)).toBeNull();
      expect(calls).toEqual([]);
    }
    for (const backend of [null, 'null', 'pcm', 'wasapi', 'coreaudio']) {
      const { run, calls } = shell({ pwDump: text(pwDump()) });
      expect(await readSink(query({ backend }), run, 'linux')).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it('runs a tool with a time limit and room for a large answer', async () => {
    const started = performance.now();
    expect(await execText(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], 200)).toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await execText('squiggly-no-such-tool', [])).toBeNull();
    expect(await execText(process.execPath, ['-e', 'process.exit(3)'])).toBeNull();
    const large = await execText(process.execPath, ['-e', 'process.stdout.write("x".repeat(1.5 * 1024 * 1024))']);
    expect(large?.length).toBe(1.5 * 1024 * 1024);
  });
});

describe('sink wording', () => {
  const sink = (patch: Partial<AudioSink> = {}): AudioSink => ({ ...dac, resampling: null, ...patch });

  it('says the server resamples only when both rates are known and differ', () => {
    expect(sinkResampling(48000, 44100)).toBe(true);
    expect(sinkResampling(48000, 48000)).toBe(false);
    expect(sinkResampling(null, 44100)).toBeNull();
    expect(sinkResampling(48000, null)).toBeNull();
  });

  it('says what the server runs the sink at, against what mpv sends', () => {
    expect(sinkSentence(sink(), 44100)).toBe('PipeWire runs the sink at 48 kHz, s32; mpv sends 44.1 kHz, so PipeWire resamples.');
    expect(sinkSentence(sink(), 48000)).toBe('PipeWire runs the sink at 48 kHz, s32, which matches the rate mpv sends.');
    expect(sinkSentence(sink(), null)).toBe('PipeWire runs the sink at 48 kHz, s32. The rate mpv sends isn\'t known.');
    expect(sinkSentence(sink({ rate: null }), 44100)).toBe('PipeWire didn\'t report what the sink runs at.');
    expect(sinkSentence(sink({ format: null }), 48000)).toBe('PipeWire runs the sink at 48 kHz, which matches the rate mpv sends.');
    expect(sinkSentence(sink({ server: 'pulseaudio', format: 's24-32le', rate: 96000 }), 44100))
      .toBe('PulseAudio runs the sink at 96 kHz, s24-32; mpv sends 44.1 kHz, so PulseAudio resamples.');
    for (const outputRate of [44100, 48000, null]) expect(sinkSentence(sink(), outputRate)).not.toMatch(/bit-perfect|DAC|!/i);
  });

  it('says a guessed sink is one, and doesn\'t say whether the server resamples', () => {
    expect(sinkSentence(sink({ route: 'default' }), 44100))
      .toBe('PipeWire runs the default sink at 48 kHz, s32. Whether PipeWire resamples isn\'t known: mpv\'s stream wasn\'t found, so it may be playing into another sink.');
    expect(sinkSentence(sink({ route: 'device', server: 'pulseaudio', rate: 44100, format: 's16le' }), 44100))
      .toBe('PulseAudio runs the sink mpv asked for at 44.1 kHz, s16. Whether PulseAudio resamples isn\'t known: mpv\'s stream wasn\'t found, so it may be playing into another sink.');
    expect(sinkSentence(sink({ route: 'default', rate: null }), 44100))
      .toBe('PipeWire didn\'t report what the default sink runs at, and mpv\'s stream wasn\'t found, so it may be playing into another sink.');
    for (const route of ['device', 'default'] as const) {
      expect(sinkSentence(sink({ route }), 44100)).not.toMatch(/so PipeWire resamples|matches/);
      expect(sinkResamples(sink({ route }), 44100)).toBeNull();
      expect(resampledNote(sink({ route, resampling: true }))).toBeNull();
    }
    expect(sinkResamples(sink(), 44100)).toBe(true);
  });

  it('puts a note on the deck only when the server resamples', () => {
    expect(resampledNote(sink({ resampling: true }))).toBe('Resampled by PipeWire.');
    expect(resampledNote(sink({ server: 'pulseaudio', resampling: true }))).toBe('Resampled by PulseAudio.');
    expect(resampledNote(sink({ resampling: false }))).toBeNull();
    expect(resampledNote(sink({ resampling: null }))).toBeNull();
    expect(resampledNote(null)).toBeNull();
  });

  it('spells sample formats one way', () => {
    const table: [string | null, string | null][] = [
      ['S32LE', 's32le'], ['S24_32LE', 's24-32le'], ['F32LE', 'f32le'], ['float32le', 'f32le'], ['float32be', 'f32be'],
      ['s16le', 's16le'], ['S24BE', 's24be'], ['UNKNOWN', null], ['', null], [null, null], ['<script>', null],
    ];
    for (const [raw, spelled] of table) expect(sinkFormat(raw)).toBe(spelled);
  });
});

describe('when the sink is asked', () => {
  afterEach(() => { vi.useRealTimers(); });

  const playing = (patch: Partial<PlayerSnapshot> = {}, audio: Partial<AudioPath> = {}): PlayerSnapshot => ({
    ...emptyPlayer(), engine: 'ready', playing: true, currentIndex: 0, playId: 'p1', ...patch,
    audio: { ...emptyAudio(), outputBackend: 'pipewire', outputRate: 44100, outputFormat: 's16', outputChannels: 'stereo', ...audio },
  });
  function watch(answer: () => Promise<SinkFacts | null> = async () => dac, platform = 'linux') {
    const queries: SinkQuery[] = [];
    const records: boolean[] = [];
    const sinks = new SinkWatch(query => { queries.push(query); return answer(); }, { platform, record: (_ms, failed) => records.push(failed) });
    return { sinks, queries, records };
  }
  // Snapshots every 250 ms, as the audio host sends them.
  async function run(sinks: SinkWatch, snapshot: PlayerSnapshot, ms: number) {
    for (let t = 0; t < ms; t += 250) { sinks.observe(snapshot, HOST_PID); await vi.advanceTimersByTimeAsync(250); }
  }

  it('asks once when a song starts, then every ten seconds while playing', async () => {
    vi.useFakeTimers();
    const { sinks, queries, records } = watch();
    await run(sinks, playing(), 9000);
    expect(queries).toEqual([{ pid: HOST_PID, backend: 'pipewire', device: 'auto' }]);
    await run(sinks, playing(), 1250);
    expect(queries).toHaveLength(2);
    await run(sinks, playing(), PROBE_EVERY_MS * 3);
    expect(queries).toHaveLength(5);
    expect(records.every(failed => !failed)).toBe(true);
  });

  it('doesn\'t ask again while paused', async () => {
    vi.useFakeTimers();
    const { sinks, queries } = watch();
    await run(sinks, playing({ playing: false }), 60_000);
    expect(queries).toHaveLength(1);
  });

  it('asks soon after a song change, but not within three seconds of the last time', async () => {
    vi.useFakeTimers();
    const { sinks, queries } = watch();
    await run(sinks, playing(), 1000);
    await run(sinks, playing({ playId: 'p2' }), PROBE_GAP_MS - 1000 - 250);
    expect(queries).toHaveLength(1);
    await run(sinks, playing({ playId: 'p2' }), 500);
    expect(queries).toHaveLength(2);
  });

  it('collapses several quick changes into one ask', async () => {
    vi.useFakeTimers();
    const { sinks, queries } = watch();
    await run(sinks, playing(), 250);
    for (const playId of ['p2', 'p3', 'p4', 'p5', 'p6']) await run(sinks, playing({ playId }), 500);
    await run(sinks, playing({ playId: 'p6' }), 1000);
    expect(queries).toHaveLength(2);
  });

  it('asks one at a time', async () => {
    vi.useFakeTimers();
    let settle: (sink: SinkFacts | null) => void = () => undefined;
    const { sinks, queries } = watch(() => new Promise(resolve => { settle = resolve; }));
    await run(sinks, playing(), 20_000);
    expect(queries).toHaveLength(1);
    expect(sinks.view(playing().audio)).toBeNull();
    settle(dac);
    await run(sinks, playing(), 250);
    expect(sinks.view(playing().audio)).toEqual({ ...dac, resampling: true });
    await run(sinks, playing(), 250);
    expect(queries).toHaveLength(2);
  });

  it('works resampling out against mpv\'s rate now, and hides a reading for another output', async () => {
    vi.useFakeTimers();
    const { sinks, queries } = watch();
    await run(sinks, playing(), 250);
    expect(sinks.view(playing().audio)?.resampling).toBe(true);
    // A song in the same format plays on gaplessly; the reading holds while it waits to be asked again.
    await run(sinks, playing({ playId: 'p2' }), 250);
    expect(sinks.view(playing({ playId: 'p2' }).audio)).toEqual({ ...dac, resampling: true });
    // mpv reopens its output at 48 kHz: nothing until the server answers for it.
    const at48 = playing({ playId: 'p3' }, { outputRate: 48000 });
    await run(sinks, at48, 250);
    expect(sinks.view(at48.audio)).toBeNull();
    await run(sinks, at48, PROBE_GAP_MS);
    // p2 never got its own ask: p3 came before the gap was over.
    expect(queries).toHaveLength(2);
    expect(sinks.view(at48.audio)).toEqual({ ...dac, resampling: false });
    expect(sinks.view({ ...at48.audio, outputRate: null, outputFormat: 'floatp' })).toBeNull();
  });

  it('keeps asking after a failure, and treats no answer as unknown', async () => {
    vi.useFakeTimers();
    let answer: 'fail' | 'none' | 'sink' = 'fail';
    const { sinks, queries, records } = watch(async () => { if (answer === 'fail') throw new Error('no'); return answer === 'none' ? null : dac; });
    await run(sinks, playing(), 250);
    expect(sinks.view(playing().audio)).toBeNull();
    expect(records).toEqual([true]);
    answer = 'sink';
    // The first ask for a song failed, so it's asked again after the gap.
    await run(sinks, playing(), PROBE_GAP_MS);
    expect(queries).toHaveLength(2);
    expect(sinks.view(playing().audio)).not.toBeNull();
    answer = 'none';
    await run(sinks, playing(), PROBE_EVERY_MS);
    expect(sinks.view(playing().audio)).toBeNull();
  });

  it('leaves resampling unknown for a guessed sink, and asks again after the gap', async () => {
    vi.useFakeTimers();
    let answer: SinkFacts = guessed('default');
    const { sinks, queries } = watch(async () => answer);
    await run(sinks, playing(), 250);
    // mpv sends 44.1 kHz and the default sink runs at 48 kHz, but mpv's stream may be elsewhere.
    expect(sinks.view(playing().audio)).toEqual({ ...guessed('default'), resampling: null });
    answer = dac;
    await run(sinks, playing(), PROBE_GAP_MS);
    expect(queries).toHaveLength(2);
    expect(sinks.view(playing().audio)).toEqual({ ...dac, resampling: true });
  });

  it('asks a guess again once per song, then keeps the usual pace', async () => {
    vi.useFakeTimers();
    const { sinks, queries } = watch(async () => guessed('device'));
    await run(sinks, playing(), PROBE_EVERY_MS - 250);
    expect(queries).toHaveLength(2);
    expect(sinks.view(playing().audio)?.resampling).toBeNull();
  });

  it('drops an answer that lands after a reset', async () => {
    vi.useFakeTimers();
    let settle: (sink: SinkFacts | null) => void = () => undefined;
    const { sinks } = watch(() => new Promise(resolve => { settle = resolve; }));
    await run(sinks, playing(), 250);
    sinks.reset();
    settle(dac);
    await vi.advanceTimersByTimeAsync(0);
    expect(sinks.view(playing().audio)).toBeNull();
  });

  it('asks nothing when there\'s nothing to ask about, or off Linux', async () => {
    vi.useFakeTimers();
    for (const snapshot of [
      playing({ engine: 'starting' }), playing({ engine: 'crashed' }), playing({ currentIndex: -1 }),
      playing({}, { outputBackend: null }), playing({}, { outputBackend: 'null' }), playing({}, { outputBackend: 'pcm' }),
    ]) {
      const { sinks, queries } = watch();
      await run(sinks, snapshot, 12_000);
      expect(queries).toEqual([]);
      expect(sinks.view(snapshot.audio)).toBeNull();
    }
    const windows = watch(async () => dac, 'win32');
    await run(windows.sinks, playing(), 12_000);
    expect(windows.queries).toEqual([]);
  });

  it('forgets the reading when playback stops', async () => {
    vi.useFakeTimers();
    const { sinks } = watch();
    await run(sinks, playing(), 250);
    expect(sinks.view(playing().audio)).not.toBeNull();
    await run(sinks, playing({ currentIndex: -1 }), 250);
    expect(sinks.view(playing().audio)).toBeNull();
  });
});
