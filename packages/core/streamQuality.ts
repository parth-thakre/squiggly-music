// What the desktop app asks Navidrome for (Settings › Streaming quality): the original file, or an
// MP3 Navidrome converts it to as it sends it, at most this many kbps, for a slow connection.
// Songs kept on the computer play from their file whatever this says. The main process sends the
// MP3s through the stream relay (apps/desktop/main/streamRelay.ts), which makes them seekable.
export const STREAM_QUALITIES = ['original', 320, 192, 128] as const;
export type StreamQuality = typeof STREAM_QUALITIES[number];
// The bitrate to ask for; null for the original.
export const reducedKbps = (quality: StreamQuality) => quality === 'original' ? null : quality;
