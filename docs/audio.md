# Audio

Squiggly tries to leave the signal alone and to be honest about what it can see.

## What it does to the audio

On the desktop, libmpv decodes and plays everything. Squiggly ignores any mpv config or scripts on your machine, asks Navidrome for the original file (`format=raw`), starts at 100% volume, turns ReplayGain off, and adds no EQ or crossfade. Anything below 100% volume is attenuation, and the signal-path line says so.

Songs play gaplessly when they share a format, as an album's songs usually do: mpv keeps the output open from one to the next, and opens the next song's stream a few seconds early so the network doesn't open a gap. When the format changes, the output reopens in the new format instead of converting the song to the old one. `tests/native.test.ts` checks both. The browser version plays through two audio elements that take turns, so it has a short gap between songs.

Exclusive output is a request to mpv. On Windows that asks WASAPI for exclusive use of the device; most Linux setups ignore it. The app reports whether mpv accepted the request. It can't tell whether the operating system actually gave it the device.

On Windows and macOS, the system media controls come from Chromium, which only shows them while the window plays audio itself. So the window plays a silent clip alongside mpv, following its play and pause. With exclusive output on, that second stream would compete with mpv for the device, so there's no silent clip. On Windows the media keys still work, but the media flyout doesn't show Squiggly. Linux uses MPRIS and has no silent clip.

The browser version plays through the browser's own audio element, so the browser decodes and the phone or computer mixes. If the browser can't decode the original (ALAC, for example), it asks the server for a 320 kbps MP3 instead, and the signal-path line says that too.

## Internet radio

Stations come from the server's list (Navidrome's Radios), and each plays its own stream. They're live, so there's no length, no position, and nothing to seek, and repeat one does nothing while one plays. Squiggly asks for the stream as it is and doesn't know what the station encoded or how. On the desktop, mpv plays the stream directly, and the line under the station says it's a live stream and what mpv decodes it as, nothing more. When the station announces what's on (ICY metadata), mpv reads it and the deck shows it; when it doesn't, the deck says internet radio. The browser version gets the stream through its host, which keeps the station's address; the browser can't read what the station announces, and the line says so. The Android app plays the stream with ExoPlayer, which reads the same announcements. Stations are never reported as played and never saved in the server's queue.

## Reading the signal path

- The source format, rate, and bit depth come from Navidrome's metadata about the file. Asking for the original doesn't prove the server sent it untouched.
- `audio-params` is what mpv decoded into. That's a sample format, not the file's original bit depth.
- `audio-out-params` is what mpv handed to the system. The system mixer or the DAC may still change it, and the app can't see that. Matching sample rates don't prove bit-perfect output.
- mpv's `cache-speed` is how fast its cache is filling. It isn't the track's bitrate or your connection's top speed.

The diagnostics page reports processes, memory, IPC traffic, and main-thread timing. Anything the app doesn't know stays blank rather than getting a plausible-looking default. An exported diagnostic report leaves out credentials, stream URLs, file paths, track names, and server addresses.
