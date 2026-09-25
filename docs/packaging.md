# Packaging and releases

## Building installers

`npm run package:win` and `npm run package:linux` build into `dist/`.

The Windows build makes an installer and a portable exe. Both carry their own Node (for the audio process), libmpv, and the Windows binaries of Koffi and esbuild. You can build it on Windows, or on Linux with Wine. It needs a libmpv build first (see below).

The Linux build makes a Fedora RPM. It carries its own Node and the Linux binaries of Koffi and esbuild, and depends on the system's `mpv-libs` instead of shipping libmpv. It needs `rpmbuild` and `libcrypt.so.1`, which electron-builder's fpm links against:

```bash
sudo dnf install rpm-build libxcrypt-compat
```

## Windows libmpv

The Windows `libmpv-2.dll` is built in this repository from source, by the recipe in `build/libmpv`. It is an audio-only build of mpv 0.41.0 and FFmpeg 8.1.3, licensed as a whole under the LGPL 2.1 or later. It is about 10 MB. It has WASAPI output, the decoders and demuxers a music player needs, HTTP and HTTPS (TLS through Windows Schannel), and no video output, scripting, disc support, or hardware decoding. `build/libmpv/README.md` lists the exact components.

```bash
npm run libmpv:build     # podman, or docker if podman is missing
```

This writes `.local/libmpv-windows/`: the DLL, `manifest.json`, the license files, and `libmpv-windows-x64-source.tar`, the source bundle each release attaches. It takes a few minutes the first time (it builds the toolchain image) and about 90 seconds after that. It does nothing when the output already matches the recipe; pass `-- --force` to rebuild anyway.

How the recipe stays reproducible:

- `build/libmpv/sources.json` pins every source tarball by URL and SHA-256. `build.mjs` downloads them into `.local/downloads` and checks them, and `build.sh` checks them again inside the container.
- The toolchain image is Debian trixie pinned by digest, with packages from snapshot.debian.org at a fixed date.
- The build runs with no network, with fixed paths and `SOURCE_DATE_EPOCH`. It gives the same DLL every time, and `build.mjs` fails unless the DLL matches `expectedDllSha256` in `sources.json`. After changing the build on purpose, update that value.
- The build fails if FFmpeg reports a GPL, version 3, or nonfree configuration, if mpv compiles one of its GPL-only files, or if the DLL imports anything other than Windows system libraries.

`scripts/fetch-windows-runtime.mjs` packages the DLL only when `.local/libmpv-windows/manifest.json` was built from the current recipe and every file still matches its recorded SHA-256. It also checks that the license files the build extracted from the sources match the copies committed in `licenses/libmpv-windows/`. Set `SQUIGGLY_LIBMPV_WINDOWS_DIR` to package a build from another directory, such as the `libmpv-windows` artifact from the release workflow.

To update a component, change its entry in `sources.json` (version, URL, SHA-256, commit), run `npm run libmpv:build`, set the new `expectedDllSha256`, copy any changed license file from `.local/libmpv-windows/licenses/` to `licenses/libmpv-windows/`, and update `licenses/libmpv-windows/NOTICE.md`.

## Pinned runtimes

The scripts in `scripts/fetch-*.mjs` download Node and the Windows binaries of Koffi and esbuild into `.local/`. Each download is checked against a SHA-256 digest (or npm integrity hash) written in the script, never against metadata fetched at the same time. The Koffi and esbuild pins must also match `package-lock.json`. Archives are cached in `.local/downloads` and re-hashed on every run; a mismatch means a fresh download. Comments in each script say how the pins were checked.

## App layout

The app ships in `resources/app.asar`. A few files run outside Electron and can't read the archive, so they stay unpacked in `resources/app.asar.unpacked`:

- `out/main/**`: the audio host (`player.js`) runs under the bundled Node, not Electron. `out/main/package.json` marks the unpacked output as ES modules.
- Koffi and its platform binary, which the audio host loads.
- esbuild's platform binary, which the extension loader spawns.

`asarUnpack` in `electron-builder.yml` lists them. If the audio host starts importing another npm package, add it there; the smoke test fails if the host can't start.

Chromium ships only its `en-US` locale pack, because the interface is English only.

## Portable exe

The portable exe unpacks the whole app into a temporary folder on every launch and deletes it on exit. Windows Defender scans each new file, so first-launch time depends on the number and size of files. With the app in `app.asar` and the smaller libmpv, the portable payload is 120 files and 458 MB (it was 3,214 files and 624 MB). Under Wine, launch-to-app time dropped from 5.4 s to 1.7 s. Real Windows with Defender should gain more, since most of the old cost was per file.

electron-builder's portable template always deletes and re-extracts the folder, so `portable.unpackDirName` can't make it reuse an earlier extraction. Storing the payload uncompressed would cut about 0.9 s under Wine, but the exe would grow from 134 MB to 458 MB, so the build keeps the default compression.

## Notices

After electron-builder copies the app, `scripts/release-notices.mjs` reads `resources/app.asar` and writes `resources/licenses/npm-packages.txt`. The build fails if a required notice is missing or a shipped package has a license nobody has reviewed. On Windows it also requires every file in `licenses/libmpv-windows/`. [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) lists everything the installers include.

## Checking a build

`npm run smoke:runtime -- <app dir>` checks the packaged runtime with the packaged Node. It runs the unpacked esbuild binary and checks its version, then starts the audio process from `app.asar.unpacked`, checks that libmpv loads, decodes a generated WAV to the null output, and exits cleanly. Point it at `dist/win-unpacked`, or at `"/opt/Squiggly Music" --expect-system-libmpv` after installing the RPM. Add `--sample <file>=<codec>` to also decode your own files, for example `--sample song.flac=flac`.

On Linux, you can check the Windows build under Wine with its own Node:

```bash
wine dist/win-unpacked/resources/runtime/node.exe scripts/smoke-runtime.mjs dist/win-unpacked > smoke.log 2>&1
```

Redirect the output to a file: Node under Wine fails to open a piped stderr.

`npm run release:checksums` writes `dist/SHA256SUMS`. The release workflow uses the same script.

## Icons

Every icon comes from `apps/desktop/renderer/public/icon.svg`. After changing it, run `npm run icons` (ImageMagick 7 with librsvg) and commit `build/`. That regenerates the Linux PNGs, the Windows `.ico`, and the tray icon.

## Releasing

The version in `package.json` is the one that ships. The workflow refuses a tag that doesn't match it.

```bash
git switch main && git pull
npm version patch        # or minor, major, or prerelease --preid beta
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`. It typechecks, builds, and runs the unit tests (with real libmpv) and the Playwright interface tests. In parallel, it builds the Windows libmpv from `build/libmpv`, cached by the recipe's contents. Then it builds the Windows installer and portable exe with that libmpv and the RPM, smoke-tests each package's runtime, and stops if anything fails. Last, it writes `SHA256SUMS`, adds build provenance attestations, and publishes a GitHub release with the libmpv source bundle attached as `Squiggly-Music-<version>-libmpv-windows-x64-source.tar`. Versions with a hyphen, like `1.2.0-beta.1`, go out as prereleases.

To build without publishing, open Actions, pick Release, and choose Run workflow. The files end up in the `release-assets` artifact.

## Verifying a download

```bash
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify <file> -R parth-thakre/squiggly-music
```

On Windows, compare `(Get-FileHash <file> -Algorithm SHA256).Hash.ToLower()` with the line in `SHA256SUMS`.

The attestation shows the release workflow built the file from the tagged commit. The Windows builds aren't code-signed yet.
