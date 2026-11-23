# Contributing

## Run from source

You need Node 22.16 or newer and libmpv (`mpv-libs` on Fedora, `libmpv2` on Debian and Ubuntu, `brew install mpv` on macOS).

```bash
npm ci
npm run dev
```

If libmpv isn't on the loader path, set `SQUIGGLY_LIBMPV_PATH` to the library file. Audio runs in a separate Node process that uses the `node` on your PATH, or `SQUIGGLY_NODE_PATH`. Installed builds bring their own Node and ignore both variables. The separate process exists because libmpv crashed inside Electron's utility process.

[development.md](development.md) covers the repo layout, running against an unpacked Fedora RPM instead of installing `mpv-libs`, and known limits.

## Before a PR

```bash
npm run check   # typecheck and build
```

Then try the change in the running app.

## Pull requests

- Keep each PR to one change.
- The signal-path readout reports only what mpv and the OS confirm. Don't make it claim bit-perfect output, and don't hide resampling or volume below 100%.
- Linux and macOS packages don't bundle libmpv, and `scripts/release-notices.mjs` fails the build if one does. [packaging.md](packaging.md) explains why.

## More docs

- [development.md](development.md): code layout, libmpv loading, and limits
- [ui-handoff.md](ui-handoff.md): how the interface is put together
- [audio.md](audio.md): what the signal-path readout can and can't tell you
- [extensions.md](extensions.md): writing extensions and what trusting one means
- [android.md](android.md): JDK and Android SDK setup, signing, and emulator testing
- [packaging.md](packaging.md): installers, pinned runtimes, releases, and checksums
