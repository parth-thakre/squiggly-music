# Packaging and releases

## Building installers

`npm run package:win`, `npm run package:linux`, and `npm run package:mac` build into `dist/`.

The Windows build makes an installer and a portable exe. Both carry their own Node (for the audio process), libmpv, and the Windows binaries of Koffi and esbuild. You can build it on Windows, or on Linux with Wine. It needs a libmpv build first (see below).

Windows names an app in its media flyout and notifications by finding a Start menu shortcut with the app's id (`appId`, `dev.squiggly.music`). The installer's shortcuts carry it. The portable exe adds a "Squiggly Music" shortcut to the user's Start menu on first launch, unless one already exists; without it the flyout says "Unknown app".

The Linux build makes a Fedora RPM. It carries its own Node and the Linux binaries of Koffi and esbuild, and depends on the system's `mpv-libs` instead of shipping libmpv. It needs `rpmbuild` and `libcrypt.so.1`, which electron-builder's fpm links against:

```bash
sudo dnf install rpm-build libxcrypt-compat
```

The macOS build makes a zip for Apple silicon (arm64) and one for Intel (x64), and on a Mac a dmg of each too. It carries its own Node and the macOS binaries of Koffi and esbuild, and uses Homebrew's libmpv instead of shipping one. It is built on Linux and hasn't been tested on a Mac yet. See [macOS](#macos) below.

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

## macOS

`npm run package:mac` builds, runs `scripts/fetch-macos-runtime.mjs`, and then `scripts/package-macos.mjs`. It writes:

- `Squiggly-Music-<version>-macos-arm64.zip` and `-macos-x64.zip`, each with its `.zip.blockmap`
- `latest-mac.yml`, which lists both zips for the updater
- `dist/mac-arm64` and `dist/mac`, the unpacked arm64 and x64 apps

On a Mac it also makes `Squiggly-Music-<version>-macos-arm64.dmg` and `-macos-x64.dmg`. It can't on Linux: electron-builder's dmg step runs `sips` and `hdiutil`, and its dmgbuild bundle is a macOS program. Releases built on this machine carry the zips only. The dmg settings in `electron-builder.yml` have never run.

The apps need macOS 13 or later (Electron 44's minimum). Each has one CPU's binaries: its own Node from nodejs.org, and Koffi's and esbuild's darwin packages from npm, all fetched by `fetch-macos-runtime.mjs` into `.local/macos-runtime/<arch>` and checked to be Mach-O files for that CPU. There is no universal build. Node ships one executable per CPU, and joining the two needs `lipo`, which only macOS has.

electron-builder zips a macOS app with 7-Zip, which follows symlinks unless it's given `-snl`. Without it every `.framework` in the app is flattened (Electron Framework's 200 MB binary is stored three times) and the bundle's layout breaks. On a Mac electron-builder uses the system `zip`, which keeps the links. Elsewhere, `package-macos.mjs` sets `ELECTRON_BUILDER_7ZIP_PATH` to a small wrapper that adds `-snl` to electron-builder's own 7za (or to `7z` on the PATH), and names both CPUs, since electron-builder builds only the host's CPU without them. Off a Mac, build the macOS packages with `npm run package:mac`, not a bare `electron-builder --mac`. Each zip should hold 14 symlinks:

```bash
zipinfo dist/Squiggly-Music-<version>-macos-arm64.zip | awk '{print substr($1,1,1)}' | sort | uniq -c
```

### macOS libmpv

The app doesn't bundle libmpv. The audio host tries `libmpv.2.dylib` in `/opt/homebrew/lib` (Homebrew on Apple silicon), `/usr/local/lib` (Homebrew on Intel), and `/opt/local/lib` (MacPorts). When none loads, the engine reports itself unavailable and the deck says to run `brew install mpv`, or with MacPorts `sudo port install mpv +libmpv` (MacPorts builds libmpv only with that variant), then restart the audio engine. `SQUIGGLY_LIBMPV_PATH` points it at a specific file instead.

The library must be built for the app's CPU: the arm64 app needs Homebrew in `/opt/homebrew`, and the x64 app, on an Intel Mac or under Rosetta, needs an Intel Homebrew in `/usr/local`. A library for the wrong CPU fails to load and the deck gives the same message. Homebrew lists no Intel macOS bottle for mpv (checked 2026-09-30), so on an Intel Mac `brew install mpv` compiles it.

Homebrew's mpv is a full build (video, scripting, and more), licensed GPL-2.0-or-later and LGPL-2.1-or-later, not the audio-only LGPL build the Windows app ships. Squiggly doesn't distribute it: the user installs it and the audio host loads it at run time. The host still ignores any mpv config and scripts, so Homebrew's `etc/mpv` has no effect.

### Unsigned

The macOS apps aren't signed or notarized, like the Windows builds. Gatekeeper stops them the first time:

- macOS 15 and later: open the app once, then choose Open Anyway in System Settings, Privacy & Security. Apple removed the Control-click way round in macOS 15.
- macOS 14 and earlier: Control-click the app, choose Open, and confirm.

Open Anyway is the way to prefer. If macOS instead says the app is damaged and offers no Open Anyway, `xattr -dr com.apple.quarantine "/Applications/Squiggly Music.app"` clears the flag on this one app. Don't run it on a folder such as Downloads or Applications: that skips Gatekeeper's check for everything in it. The command hasn't been tried with this app.

The updater only says a new version is out on macOS. electron-updater installs macOS updates through Squirrel.Mac, which needs a signed app. It still reads `latest-mac.yml` for the version.

Built on Linux, not yet tested on a Mac. What only a Mac can show: that the app starts and how Gatekeeper treats it; that the bundled Node loads Homebrew's libmpv; Keychain prompts when the app saves a sign-in; the Local Network prompt for a Navidrome on the local network; the system media controls through the silent clip; the tray icon; the application menu and Cmd shortcuts (the default keys use Ctrl; `keybindings.json` accepts `meta`); reopening a window hidden to the tray from the Dock; and the dmg.

## Pinned runtimes

The scripts in `scripts/fetch-*.mjs` download Node and the Windows binaries of Koffi and esbuild into `.local/`. `fetch-macos-runtime.mjs` does the same for macOS, for each CPU, into `.local/macos-runtime/<arch>`. Each download is checked against a SHA-256 digest (or npm integrity hash) written in the script, never against metadata fetched at the same time. The Koffi and esbuild pins must also match `package-lock.json`. Archives are cached in `.local/downloads` and re-hashed on every run; a mismatch means a fresh download. Comments in each script say how the pins were checked.

## App layout

The app ships in `resources/app.asar`. A few files run outside Electron and can't read the archive, so they stay unpacked in `resources/app.asar.unpacked`:

- `out/main/**`: the audio host (`player.js`) runs under the bundled Node, not Electron. `out/main/package.json` marks the unpacked output as ES modules.
- Koffi and its platform binary, which the audio host loads.
- esbuild's platform binary, which the extension loader spawns.

`asarUnpack` in `electron-builder.yml` lists them. The Windows and macOS binaries are mapped in from `.local/` and matched by their source folders' names (`koffi-darwin-*`, `esbuild-darwin-*`). A macOS app keeps all of this in `Squiggly Music.app/Contents/Resources` instead of `resources`. If the audio host starts importing another npm package, add it there; the smoke test fails if the host can't start.

Chromium ships only its `en-US` locale pack, because the interface is English only.

## Portable exe

The portable exe unpacks the whole app into a temporary folder on every launch and deletes it on exit. Windows Defender scans each new file, so first-launch time depends on the number and size of files. With the app in `app.asar` and the smaller libmpv, the portable payload is 120 files and 458 MB (it was 3,214 files and 624 MB). Under Wine, launch-to-app time dropped from 5.4 s to 1.7 s. Real Windows with Defender should gain more, since most of the old cost was per file.

electron-builder's portable template always deletes and re-extracts the folder, so `portable.unpackDirName` can't make it reuse an earlier extraction. Storing the payload uncompressed would cut about 0.9 s under Wine, but the exe would grow from 134 MB to 458 MB, so the build keeps the default compression.

## Notices

After electron-builder copies the app, `scripts/release-notices.mjs` reads `resources/app.asar` and writes `resources/licenses/npm-packages.txt`. The build fails if a required notice is missing or a shipped package has a license nobody has reviewed. On Windows it also requires every file in `licenses/libmpv-windows/`. electron-builder deletes Electron's `LICENSE` and `LICENSES.chromium.html` from a macOS app, so the same script, run as the `afterExtract` hook, copies them into the bundle's `Contents/Resources/licenses` first, and the check requires them there. A macOS package fails the check if it contains any libmpv. [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) lists everything the installers include.

## Checking a build

`npm run smoke:runtime -- <app dir>` checks the packaged runtime with the packaged Node. It runs the unpacked esbuild binary and checks its version, then starts the audio process from `app.asar.unpacked`, checks that libmpv loads, decodes a generated WAV to the null output, and exits cleanly. Point it at `dist/win-unpacked`, or at `"/opt/Squiggly Music" --expect-system-libmpv` after installing the RPM. For macOS, point it at `dist/mac-arm64` or `dist/mac` (or a `.app`). On a Mac with Homebrew's mpv it runs the full test; anywhere else it only checks that the bundled Node, Koffi, and esbuild are Mach-O binaries for the bundle's CPU, that no other CPU's are there, and that there is no libmpv. Add `--sample <file>=<codec>` to also decode your own files, for example `--sample song.flac=flac`.

On Linux, you can check the Windows build under Wine with its own Node:

```bash
wine dist/win-unpacked/resources/runtime/node.exe scripts/smoke-runtime.mjs dist/win-unpacked > smoke.log 2>&1
```

Redirect the output to a file: Node under Wine fails to open a piped stderr.

`npm run release:checksums` writes `dist/SHA256SUMS`. The release workflow uses the same script.

## Icons

Every icon comes from `apps/desktop/renderer/public/icon.svg`. After changing it, run `npm run icons` (ImageMagick 7 with librsvg) and commit `build/`. That regenerates the Linux PNGs, the Windows `.ico`, and the tray icon. The macOS `.icns` isn't committed: electron-builder makes it from `build/icon.png` when it packages the app (ImageMagick here can't write ICNS). The first time, it downloads its icon tool.

## Releasing

The version in `package.json` is the one that ships, and the tag is `v` plus that version. The app's updater (`apps/desktop/main/updates.ts`) compares its own version with the newest GitHub release, so every release needs a new version, and must include `latest.yml`, `latest-linux.yml`, `latest-mac.yml`, and the installer's and zips' `.blockmap` files alongside the installers: electron-updater reads the version and SHA-512 from them. Versions with a hyphen go out as prereleases, which the updater skips.

Releases are built on this machine and uploaded. The Release workflow is disabled in the repository's Actions settings, so pushing a tag builds nothing on GitHub:

```bash
git switch main && git pull
npm version patch --no-git-tag-version   # or minor, major
git commit -am "release: v$(node -p "require('./package.json').version")"
npm ci && npm run check && npm run test:ui
npm run libmpv:build                     # or keep .local/libmpv-windows; package:win verifies it
npm run package:win && npm run package:linux && npm run package:mac
npm run android:build                    # needs the Android toolchain and release key (docs/android.md)
node scripts/smoke-runtime.mjs dist/win-unpacked   # under Wine: wine dist/win-unpacked/resources/runtime/node.exe ...
node scripts/smoke-runtime.mjs dist/mac-arm64 && node scripts/smoke-runtime.mjs dist/mac   # static checks off a Mac
mkdir release && cp dist/*.exe dist/*.exe.blockmap dist/latest.yml dist/*.rpm dist/latest-linux.yml release/
cp dist/*-macos-*.zip dist/*-macos-*.zip.blockmap dist/latest-mac.yml release/
cp dist/android/squiggly-$(node -p "require('./package.json').version")-release.apk "release/Squiggly-Music-$(node -p "require('./package.json').version")-android.apk"
cp .local/libmpv-windows/libmpv-windows-x64-source.tar "release/Squiggly-Music-$(node -p "require('./package.json').version")-libmpv-windows-x64-source.tar"
node scripts/release-checksums.mjs release
git push && gh release create "v$(node -p "require('./package.json').version")" release/* --target main --title "Squiggly Music $(node -p "require('./package.json').version")" --notes-file <notes>
```

The notes start from `.github/release-notes-header.md` with `{{VERSION}}`, `{{TAG}}`, and `{{REPO}}` filled in; drop the attestation section, since locally built files have no GitHub attestation.

With the workflow enabled again, pushing a `v*` tag runs `.github/workflows/release.yml` instead. It typechecks, builds, and runs the unit tests (with real libmpv) and the Playwright interface tests. In parallel, it builds the Windows libmpv from `build/libmpv`, cached by the recipe's contents. Then it builds the Windows installer and portable exe with that libmpv and the RPM, smoke-tests each package's runtime, and stops if anything fails. Last, it writes `SHA256SUMS`, adds build provenance attestations, and publishes a GitHub release with the libmpv source bundle attached as `Squiggly-Music-<version>-libmpv-windows-x64-source.tar`. Versions with a hyphen, like `1.2.0-beta.1`, go out as prereleases.

To build without publishing, open Actions, pick Release, and choose Run workflow. The files end up in the `release-assets` artifact.

The workflow doesn't build macOS. A macOS job would need a macOS runner (for the dmg), `brew install mpv` for the smoke test, and a new artifact pattern in the assemble job, which downloads only artifacts named `*-x64`.

## Verifying a download

```bash
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify <file> -R parth-thakre/squiggly-music
```

On Windows, compare `(Get-FileHash <file> -Algorithm SHA256).Hash.ToLower()` with the line in `SHA256SUMS`. On macOS, `shasum` checks one file's line:

```bash
grep ' Squiggly-Music-.*-macos-arm64.zip$' SHA256SUMS | shasum -a 256 -c
```

The attestation shows the release workflow built the file from the tagged commit. The Windows and macOS builds aren't code-signed yet.
