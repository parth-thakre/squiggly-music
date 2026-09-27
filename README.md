<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.png">
    <img alt="Squiggly" src="docs/brand/lockup-light.png" width="400">
  </picture>
</h1>

Squiggly plays your own music from Navidrome. It asks the server for the original files, plays them through libmpv, and tells you what it knows about the signal path and what it can't know. The window takes its colours from the record that's playing.

It's early software. It runs on Windows and Fedora, and a browser version works on phones.

## What it does

- Browse records, artists, playlists, and favorites on your server, or play files from your computer.
- Edit the queue and your playlists. The queue follows you between devices through the server.
- Start a radio station from any song, record, or artist.
- Build automatic playlists from your library by genre, by decade, and from what's new.
- Show synced lyrics from your files. Looking up missing lyrics on LRCLIB is off until you turn it on.
- Run as a mini player or from the tray, with media keys, and with MPRIS on Linux.
- Ask Windows for exclusive output. The app reports what mpv accepted and doesn't claim more.
- Find any action with Ctrl+K. Change its keys in `keybindings.json` and add colour themes as files in the config folder (`~/.config/squiggly`, or `%APPDATA%\Squiggly` on Windows); saved changes apply at once.
- Add your own commands, menu items, pages, and themes with extensions: folders of TypeScript in the config folder that reload when you save.

It doesn't do EQ, crossfade, or loudness levelling. It leaves the signal alone, and if you turn the volume below 100% it tells you that's attenuation.

## Install

Download a build from [Releases](https://github.com/parth-thakre/squiggly-music/releases), along with `SHA256SUMS` from the same release, and check it:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

On Windows, run the setup program or the portable exe. They aren't signed yet, so SmartScreen will warn you. Choose More info, then Run anyway.

On Fedora, `sudo dnf install ./squiggly-music-<version>.x86_64.rpm` installs Squiggly and pulls in `mpv-libs`.

To connect, enter your Navidrome address with any port or subpath (`https://music.example.com/navidrome` works), your username, and your password. The password stays in memory for the session. Squiggly doesn't save it.

## Run from source

You need Node 22.16 or newer and libmpv (`mpv-libs` on Fedora).

```bash
npm ci
npm run dev
```

If libmpv isn't on the loader path, set `SQUIGGLY_LIBMPV_PATH` to the library file. Audio runs in a separate Node process that uses the `node` on your PATH, or `SQUIGGLY_NODE_PATH`. Installed builds bring their own Node. The separate process exists because libmpv crashed inside Electron's utility process.

## Browser version

```bash
SQUIGGLY_PREVIEW_NAVIDROME_URL=https://music.example.com \
SQUIGGLY_PREVIEW_NAVIDROME_USER=you \
SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD='your navidrome password' \
SQUIGGLY_WEB_PASSWORD='a long password for this page' \
npm run web
```

This serves the app on 127.0.0.1:5173 and keeps the Navidrome login on the server. Anyone who can open the page acts as that account, so it won't serve other devices unless `SQUIGGLY_WEB_PASSWORD` is set to 12 or more characters. To reach it from your phone over Tailscale, run `tailscale serve --bg 5173`. The browser plays the audio here, not libmpv, and the signal-path line says so.

## Tests

```bash
npm run check     # typecheck, build, unit and integration tests
npm run test:ui   # the real interface in Chromium, against a fake Navidrome
```

The libmpv tests only decode audio when `SQUIGGLY_LIBMPV_PATH` points at a library. Otherwise they skip. [docs/development.md](docs/development.md) has the rest.

## More

- [docs/packaging.md](docs/packaging.md) covers installers, pinned runtimes, releases, and checksums.
- [docs/audio.md](docs/audio.md) explains what the signal-path readout can and can't tell you.
- [docs/ui-handoff.md](docs/ui-handoff.md) describes how the interface is put together.
- [docs/extensions.md](docs/extensions.md) covers writing extensions and what trusting one means.

## License

Squiggly is [MIT](LICENSE) licensed. The installers include other people's software under their own licenses, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
