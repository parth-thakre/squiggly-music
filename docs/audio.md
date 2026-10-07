# Audio

Squiggly tries to leave the signal alone and to be honest about what it can see.

## What it does to the audio

On the desktop, libmpv decodes and plays everything. Squiggly ignores any mpv config or scripts on your machine, asks Navidrome for the original file (`format=raw`), starts at 100% volume, turns ReplayGain off, and adds no EQ or crossfade. Anything below 100% volume is attenuation, and the signal-path line says so.

On macOS the libmpv is the one you installed with Homebrew (or MacPorts), not one the app ships, so the signal-path line reports what that mpv says. Its media-key handling is off, as it is for any libmpv, so it doesn't compete with the app for the system's Now Playing controls.

Songs play gaplessly when they share a format, as an album's songs usually do: mpv keeps the output open from one to the next, and opens the next song's stream a few seconds early so the network doesn't open a gap. When the format changes, the output reopens in the new format instead of converting the song to the old one. `tests/native.test.ts` checks both. The browser version plays through two audio elements that take turns, so it has a short gap between songs.

Exclusive output is a request to mpv. On Windows that asks WASAPI for exclusive use of the device, and on macOS CoreAudio; most Linux setups ignore it. The app reports whether mpv accepted the request. It can't tell whether the operating system actually gave it the device. On Linux the app also asks the sound server what it runs the sink at, which shows whether the server resamples what mpv sends (see [The sink line](#the-sink-line)).

On Windows and macOS, the system media controls come from Chromium, which only shows them while the window plays audio itself. So the window plays a silent clip alongside mpv, following its play and pause. With exclusive output on, that second stream would compete with mpv for the device, so there's no silent clip. On Windows the media keys still work, but the media flyout doesn't show Squiggly. Linux uses MPRIS and has no silent clip.

The browser version plays through the browser's own audio element, so the browser decodes and the phone or computer mixes. If the browser can't decode the original (ALAC, for example), it asks the server for a 320 kbps MP3 instead, and the signal-path line says that too.

## Internet radio

Stations come from the server's list (Navidrome's Radios), and each plays its own stream. They're live, so there's no length, no position, and nothing to seek, and repeat one does nothing while one plays. On the desktop, while a station is anywhere in the queue, mpv opens nothing early, so a station joins the broadcast when its turn comes rather than playing what it sent minutes before; songs in that queue can have a short gap between them over a slow network. Squiggly asks for the stream as it is and doesn't know what the station encoded or how. On the desktop, mpv plays the stream directly, and the line under the station says it's a live stream and what mpv decodes it as, nothing more. When the station announces what's on (ICY metadata), mpv reads it and the deck shows it; when it doesn't, the deck says internet radio. The browser version gets the stream through its host, which keeps the station's address; the browser can't read what the station announces, and the line says so. The Android app plays the stream with ExoPlayer, which reads the same announcements. Stations are never reported as played and never saved in the server's queue.

## Kept songs

Keeping asks the server for the original file (`format=raw`) and stores the bytes that arrive, unchanged. Squiggly never converts them. As with streaming, that doesn't prove the server sent the file untouched. A kept song plays from its file. mpv or ExoPlayer opens it like any local file, and the line under the song says so only when the player opened the kept file.

## Reading the signal path

- The source format, rate, and bit depth come from Navidrome's metadata about the file. Asking for the original doesn't prove the server sent it untouched.
- `audio-params` is what mpv decoded into. That's a sample format, not the file's original bit depth.
- `audio-out-params` is what mpv handed to the system. The system mixer or the DAC may still change it, and the app can't see that. Matching sample rates don't prove bit-perfect output.
- On Linux, the sink line is what PipeWire or PulseAudio says it runs the sink mpv plays into at. It's the server's report about its sink, not what the DAC receives.
- mpv's `cache-speed` is how fast its cache is filling. It isn't the track's bitrate or your connection's top speed.

The diagnostics page reports processes, memory, IPC traffic, and main-thread timing. Anything the app doesn't know stays blank rather than getting a plausible-looking default. An exported diagnostic report leaves out credentials, stream URLs, file paths, track names, and server addresses. It includes the output device mpv was asked to use and, on Linux, the sink's description as the sound server gives it (the name you see in the system's sound settings).

## The sink line

On Linux, the main process asks the sound server what it runs the sink at, and the Diagnostics page shows it in a Sink row: the sink's name, and a sentence such as "PipeWire runs the sink at 48 kHz, s32; mpv sends 44.1 kHz, so PipeWire resamples." The deck's line stays as it is unless the server resamples, and then it adds "Resampled by PipeWire."

How it asks:

- `pw-dump` when it's there (it comes with `pipewire-utils` on Fedora). Otherwise `pactl -f json list sinks` and `list sink-inputs`, which PulseAudio 16 or newer and pipewire-pulse answer. A pipewire-pulse sink is reported as PipeWire's.
- For mpv's PipeWire output, PipeWire's answer settles it. mpv's other outputs may be talking to another server: PulseAudio can play while PipeWire runs only for screen sharing, as on Ubuntu 22.04, and `PULSE_SERVER` can point anywhere. So for them PipeWire's answer counts only when mpv's stream is in it, and otherwise `pactl` is asked. With no `pactl`, the line stays blank.
- It finds the sink by following mpv's own stream: the stream that belongs to the audio process, and the sink the server has linked it to. When there's no such stream, mpv's output device (`pipewire/<name>`, `pulse/<name>`) names the sink, or else the server's default sink. Those two are guesses, since the session manager can move a stream elsewhere, so the stream always comes first. A guessed sink says so on the Diagnostics page ("the default sink", "the sink mpv asked for"), whether the server resamples stays unknown, and the deck says nothing. It's asked again after 3 seconds, in case the stream has turned up. A stream linked to something other than one sink leaves the line blank.
- Only on Linux, and only while a song is loaded and mpv plays through PipeWire, PulseAudio, ALSA, or JACK. ALSA and JACK are found by their stream alone; ALSA straight to the hardware has no server in the way, and no line.
- When a song starts or mpv's output changes, and every 10 seconds while playing. Never more often than once every 3 seconds, one ask at a time, and each tool gets 2 seconds before it's stopped. The row disappears as soon as mpv's output rate, format, channels, or device change, until the server has answered for the new ones.
- If neither tool is installed or answers, the row stays blank. Nothing else depends on it.

What it can tell: the sample rate, sample format, and channel count the server has opened the sink with, and, for a sink found through mpv's stream, whether that rate differs from the rate mpv hands over, in which case the server resamples. The sentence says "matches" when the two rates are equal.

What it can't tell:

- What a USB DAC or an amplifier does after the server. The line stops at the sink.
- Anything past a virtual sink. With EasyEffects or a filter chain, mpv's stream links to that sink, and the line describes it rather than the hardware behind it.
- Conversion inside the server other than at mpv's stream. Only mpv's rate and the sink's rate are compared; other volume, mixing, or format changes don't show.
- A suspended PipeWire sink has no current format, so its rate stays blank. PulseAudio reports a sink's sample specification even while it's suspended.
- Nothing here proves bit-perfect output. "Matches" means two rates are equal, not that nothing else changed the audio.

### Following the source rate

The app never asks PipeWire to switch rates. mpv's PipeWire output tags its stream with the rate it sends (`node.rate = 1/44100`, say) and doesn't force it. PipeWire's documentation says it switches the graph to a stream's rate only when that rate is in `default.clock.allowed-rates` and the devices are idle. PipeWire's stock configuration allows only 48000, so a 44.1 kHz file plays into a sink at 48 kHz and the line says PipeWire resamples; a 48 kHz file says the sink matches. That much was checked on a Fedora machine with PipeWire 1.6.9.

With a longer list, for example `default.clock.allowed-rates = [ 44100 48000 88200 96000 ]` in a file under `~/.config/pipewire/pipewire.conf.d/`, and nothing else playing, the sink should open at the file's rate and the line should say it matches. If another application keeps the sink busy, the sink stays at its rate and the line says PipeWire resamples. Those two cases come from PipeWire's documentation and weren't run here; the sink line is how to see which one your setup gives.

mpv's `audio-exclusive` becomes a flag on its PipeWire stream (`node.exclusive = true`). What the session manager does with it isn't something the sink line shows.
