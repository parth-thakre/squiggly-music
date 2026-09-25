# Audio

Squiggly tries to leave the signal alone and to be honest about what it can see.

## What it does to the audio

On the desktop, libmpv decodes and plays everything. Squiggly ignores any mpv config or scripts on your machine, asks Navidrome for the original file (`format=raw`), starts at 100% volume, turns ReplayGain off, and adds no EQ or crossfade. Anything below 100% volume is attenuation, and the signal-path line says so.

Exclusive output is a request to mpv. On Windows that asks WASAPI for exclusive use of the device; most Linux setups ignore it. The app reports whether mpv accepted the request. It can't tell whether the operating system actually gave it the device.

The browser version plays through the browser's own audio element, so the browser decodes and the phone or computer mixes. If the browser can't decode the original (ALAC, for example), it asks the server for a 320 kbps MP3 instead, and the signal-path line says that too.

## Reading the signal path

- The source format, rate, and bit depth come from Navidrome's metadata about the file. Asking for the original doesn't prove the server sent it untouched.
- `audio-params` is what mpv decoded into. That's a sample format, not the file's original bit depth.
- `audio-out-params` is what mpv handed to the system. The system mixer or the DAC may still change it, and the app can't see that. Matching sample rates don't prove bit-perfect output.
- mpv's `cache-speed` is how fast its cache is filling. It isn't the track's bitrate or your connection's top speed.

The diagnostics page reports processes, memory, IPC traffic, and main-thread timing. Anything the app doesn't know stays blank rather than getting a plausible-looking default. An exported diagnostic report leaves out credentials, stream URLs, file paths, track names, and server addresses.
