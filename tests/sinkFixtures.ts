// Sound server output for tests/sinks.test.ts. The PipeWire objects are trimmed from a real
// `pw-dump` (PipeWire 1.6.9, WirePlumber 0.5.17) taken while libmpv played a silent WAV through
// ao=pipewire, and the pactl ones from `pactl -f json` (pactl 17.0 on pipewire-pulse). Names, the
// Bluetooth address, serials, and process ids are replaced; shapes and values are kept.

export const SINK = 'alsa_output.usb-Example_DAC-00.analog-stereo';
export const SINK_DESCRIPTION = 'Example DAC Analog Stereo';
export const BLUETOOTH = 'bluez_output.00_00_00_00_00_00.1';
export const HOST_PID = 4242;
// The file name mpv puts in its stream's media.name. It must never reach a reading.
export const SECRET = 'Secret Song.flac';

type Format = { format: string; rate: number; channels: number };
const raw = ({ format, rate, channels }: Format) => ({ mediaType: 'audio', mediaSubtype: 'raw', format, rate, channels, position: channels === 2 ? ['FL', 'FR'] : ['MONO'] });

// The two driver nodes every PipeWire lists, with no media class.
export const driverNodes = () => ['Dummy-Driver', 'Freewheel-Driver'].map((name, i) => ({
  id: 30 + i, type: 'PipeWire:Interface:Node', version: 3, permissions: ['r', 'x'],
  info: {
    'max-input-ports': 0, 'max-output-ports': 0, 'change-mask': ['input-ports', 'output-ports', 'state', 'props', 'params'],
    'n-input-ports': 0, 'n-output-ports': 0, state: 'suspended', error: null,
    props: { 'factory.id': 10, 'node.name': name, 'node.group': 'pipewire.dummy', 'priority.driver': 200000 - i, 'object.id': 30 + i },
    params: {},
  },
}));

// An ALSA sink. `format` null means suspended: PipeWire then lists no Format at all.
export function sinkNode(id: number, name = SINK, description: string | null = SINK_DESCRIPTION, format: Format | null = { format: 'S32LE', rate: 48000, channels: 2 }) {
  return {
    id, type: 'PipeWire:Interface:Node', version: 3, permissions: ['r', 'x'],
    info: {
      'max-input-ports': 65, 'max-output-ports': 65, 'change-mask': ['input-ports', 'output-ports', 'state', 'props', 'params'],
      'n-input-ports': 2, 'n-output-ports': 2, state: format ? 'running' : 'suspended', error: null,
      props: {
        'alsa.card': 0, 'alsa.card_name': 'Example DAC', 'alsa.driver_name': 'snd_usb_audio', 'alsa.resolution_bits': 16,
        'api.alsa.path': 'front:0', 'api.alsa.pcm.stream': 'playback', 'audio.channels': 2, 'audio.position': '[ FL, FR ]',
        'client.id': 34, 'device.api': 'alsa', 'device.bus': 'usb', 'device.class': 'sound', 'device.id': 151,
        'device.profile.description': 'Analog Stereo', 'device.profile.name': 'analog-stereo', 'factory.name': 'api.alsa.pcm.sink',
        'library.name': 'audioconvert/libspa-audioconvert', 'media.class': 'Audio/Sink',
        ...(description === null ? {} : { 'node.description': description }),
        'node.driver': true, 'node.max-latency': '16384/48000', 'node.name': name, 'node.nick': 'Example DAC',
        'object.id': id, 'object.path': 'alsa:acp:DAC:3:playback', 'object.serial': 13880, 'priority.driver': 1109, 'priority.session': 1109,
      },
      params: {
        // What the sink could run at, in PipeWire's choice objects. Never read.
        EnumFormat: [{ mediaType: 'audio', mediaSubtype: 'raw', format: { default: 'S32LE', alt1: 'S32LE', alt2: 'S24LE', alt3: 'S16LE' }, rate: { default: 48000, min: 8000, max: 384000 }, channels: 2, position: ['FL', 'FR'] }],
        PropInfo: [], Props: [{ volume: 1, mute: false, channelVolumes: [0.1, 0.1] }],
        Format: format ? [raw(format)] : [],
        EnumPortConfig: [], PortConfig: [], Latency: [], ProcessLatency: [], Tag: [],
      },
    },
  };
}

// mpv's stream through ao=pipewire: no process id on the node, only its client's id. Through
// ao=pulse (pipewire-pulse), `pid` puts the process id on the node itself.
export function mpvStream(id = 130, options: { clientId?: number; pid?: number; format?: Format; mediaClass?: string } = {}) {
  const format = options.format ?? { format: 'S16LE', rate: 44100, channels: 2 };
  return {
    id, type: 'PipeWire:Interface:Node', version: 3, permissions: ['r', 'x'],
    info: {
      'max-input-ports': 0, 'max-output-ports': 64, 'change-mask': ['input-ports', 'output-ports', 'state', 'props', 'params'],
      'n-input-ports': 0, 'n-output-ports': 2, state: 'running', error: null,
      props: {
        'application.icon-name': 'mpv', 'application.id': 'mpv', 'application.language': 'en_US.UTF-8', 'application.name': 'mpv',
        'client.id': options.clientId ?? 52, 'factory.id': 7, 'library.name': 'audioconvert/libspa-audioconvert',
        'media.category': 'Playback', 'media.class': options.mediaClass ?? 'Stream/Output/Audio', 'media.icon-name': 'audio-x-generic',
        'media.name': `${SECRET} - mpv`, 'media.role': 'Music', 'media.type': 'Audio', 'node.autoconnect': true, 'node.driver-id': 150,
        'node.latency': '2048/44100', 'node.name': 'mpv', 'node.rate': `1/${format.rate}`, 'node.want-driver': true,
        'object.id': id, 'object.serial': 21000, 'port.group': 'stream.0', 'stream.is-live': true, 'target.object': 'auto',
        ...(options.pid === undefined ? {} : { 'application.process.id': options.pid, 'client.api': 'pipewire-pulse' }),
      },
      params: {
        EnumFormat: [raw(format)], PropInfo: [], Props: [], Format: [raw(format)], EnumPortConfig: [], PortConfig: [], Latency: [], Tag: [],
      },
    },
  };
}

export function client(id: number, pid: number, name = 'mpv') {
  return {
    id, type: 'PipeWire:Interface:Client', version: 3, permissions: ['r', 'w', 'x', 'm'],
    info: {
      'change-mask': ['props'],
      props: {
        'application.language': 'en_US.UTF-8', 'application.name': name, 'application.process.binary': 'node',
        'application.process.host': 'example', 'application.process.id': pid, 'application.process.user': 'listener',
        'core.name': `pipewire-listener-${pid}`, 'core.version': '1.6.9', 'module.id': 2, 'object.id': id, 'object.serial': id,
        'pipewire.protocol': 'protocol-native', 'pipewire.sec.pid': pid, 'pipewire.sec.uid': 1000,
      },
    },
  };
}

// One Link per channel, as PipeWire makes them.
export function link(id: number, from: number, to: number) {
  return {
    id, type: 'PipeWire:Interface:Link', version: 3, permissions: ['r', 'x'],
    info: {
      'output-node-id': from, 'output-port-id': id + 1000, 'input-node-id': to, 'input-port-id': id + 2000,
      'change-mask': ['state', 'format', 'props'], state: 'active', error: null, format: null,
      props: { 'client.id': 34, 'factory.id': 21, 'link.async': true, 'link.input.node': to, 'link.output.node': from, 'object.id': id },
    },
  };
}

// WirePlumber's `default` metadata. default.configured.audio.sink names a Bluetooth sink that isn't
// there, as it did on the machine the dump came from.
export function defaults(sink: string | null = SINK, configured = 'bluez_output.11_22_33_44_55_66.1') {
  return {
    id: 40, type: 'PipeWire:Interface:Metadata', version: 3, permissions: ['r', 'w', 'x'],
    props: { 'client.id': 34, 'factory.id': 7, 'metadata.name': 'default', 'module.id': 6, 'object.serial': 40 },
    metadata: [
      { subject: 0, key: 'default.configured.audio.sink', type: 'Spa:String:JSON', value: { name: configured } },
      ...(sink === null ? [] : [{ subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: { name: sink } }]),
      { subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: { name: 'alsa_input.usb-Example_DAC-00.mono-fallback' } },
    ],
  };
}
export const settingsMetadata = () => ({
  id: 39, type: 'PipeWire:Interface:Metadata', version: 3, permissions: ['r', 'w', 'x'],
  props: { 'client.id': 34, 'factory.id': 7, 'metadata.name': 'settings', 'module.id': 6, 'object.serial': 39 },
  metadata: [
    { subject: 0, key: 'clock.rate', type: '', value: 48000 },
    { subject: 0, key: 'clock.allowed-rates', type: '', value: '[ 48000 ]' },
    { subject: 0, key: 'clock.force-rate', type: '', value: 0 },
  ],
});
const core = () => ({ id: 0, type: 'PipeWire:Interface:Core', version: 4, permissions: ['r', 'x', 'm'], info: { name: 'pipewire-0', version: '1.6.9', props: {} } });

// The default dump: the DAC (150) and a Bluetooth sink (160), mpv's stream (130) from client 52
// (the audio host, HOST_PID), linked to the DAC on both channels.
export function pwDump(parts: { without?: 'stream'; extra?: object[]; replace?: Record<number, object> } = {}): object[] {
  const objects: object[] = [
    core(), ...driverNodes(), settingsMetadata(), defaults(), client(34, 1000, 'WirePlumber'),
    sinkNode(150), sinkNode(160, BLUETOOTH, 'Headphones', { format: 'S16LE', rate: 44100, channels: 2 }),
    ...(parts.without === 'stream' ? [] : [client(52, HOST_PID), mpvStream(130), link(170, 130, 150), link(171, 130, 150)]),
    ...(parts.extra ?? []),
  ];
  return objects.map(object => parts.replace?.[(object as { id: number }).id] ?? object);
}
export const text = (value: unknown) => JSON.stringify(value, null, 2);

// pactl -f json list sinks. The first is pipewire-pulse's, as captured. The second is made by hand
// in the shape of the first for a PulseAudio sink: its driver is the module that made it.
export const pactlSinks = () => [
  {
    index: 13880, state: 'RUNNING', name: SINK, description: SINK_DESCRIPTION, driver: 'PipeWire',
    sample_specification: 's32le 2ch 48000Hz', channel_map: 'front-left,front-right', owner_module: 4294967295, mute: false,
    volume: { 'front-left': { value: 30802, value_percent: '47%', db: '-19.67 dB' }, 'front-right': { value: 30802, value_percent: '47%', db: '-19.67 dB' } },
    balance: 0, base_volume: { value: 65536, value_percent: '100%', db: '0.00 dB' }, monitor_source: `${SINK}.monitor`,
    latency: { actual: 0, configured: 0 }, flags: ['HARDWARE', 'DECIBEL_VOLUME', 'LATENCY'],
    properties: { 'alsa.card': '0', 'device.api': 'alsa', 'media.class': 'Audio/Sink', 'node.name': SINK }, active_port: 'analog-output', formats: ['pcm'],
  },
  {
    index: 1, state: 'SUSPENDED', name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', driver: 'module-alsa-card.c',
    sample_specification: 's16le 2ch 44100Hz', channel_map: 'front-left,front-right', owner_module: 7, mute: false,
    volume: { 'front-left': { value: 65536, value_percent: '100%', db: '0.00 dB' }, 'front-right': { value: 65536, value_percent: '100%', db: '0.00 dB' } },
    balance: 0, base_volume: { value: 65536, value_percent: '100%', db: '0.00 dB' }, monitor_source: 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor',
    latency: { actual: 0, configured: 0 }, flags: ['HARDWARE', 'DECIBEL_VOLUME', 'LATENCY'],
    properties: { 'alsa.card': '1', 'device.api': 'alsa' }, active_port: 'analog-output-speaker', formats: ['pcm'],
  },
];
// pactl -f json list sink-inputs: mpv through ao=pulse, playing into the sink with this index.
export const pactlInputs = (sink = 13880, pid = String(HOST_PID)) => [
  {
    index: 19047, driver: 'PipeWire', owner_module: null, client: '19046', sink, sample_specification: 's16le 2ch 44100Hz',
    channel_map: 'front-left,front-right', format: 'pcm, format.sample_format = "\\"s16le\\""  format.rate = "44100"', corked: false, mute: false,
    volume: { 'front-left': { value: 65536, value_percent: '100%', db: '0.00 dB' } }, balance: 0, buffer_latency_usec: 0, sink_latency_usec: 0,
    resample_method: 'PipeWire',
    properties: { 'client.api': 'pipewire-pulse', 'application.name': 'mpv', 'application.process.id': pid, 'media.name': `${SECRET} - mpv`, 'node.rate': '1/44100' },
  },
];
export const pactlInfo = (defaultSink = SINK) => ({
  server_string: '/run/user/1000/pulse/native', library_protocol_version: 35, server_protocol_version: 35, is_local: 'yes',
  server_name: 'PulseAudio (on PipeWire 1.6.9)', server_version: '15.0.0', default_sample_specification: 'float32le 2ch 48000Hz',
  default_channel_map: 'front-left,front-right', default_sink_name: defaultSink, default_source_name: 'alsa_input.usb-Example_DAC-00.mono-fallback',
});
