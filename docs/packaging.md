# Packaging and releases

## Building installers

`npm run package:win` and `npm run package:linux` build into `dist/`.

The Windows build makes an installer and a portable exe. Both carry their own Node (for the audio process), libmpv, and Koffi's Windows binary. You can build it on Windows, or on Linux with Wine.

The Linux build makes a Fedora RPM. It carries its own Node and Koffi's Linux binary, and depends on the system's `mpv-libs` instead of shipping libmpv. It needs `rpmbuild` and `libcrypt.so.1`, which electron-builder's fpm links against:

```bash
sudo dnf install rpm-build libxcrypt-compat
```

## Pinned runtimes

The scripts in `scripts/fetch-*.mjs` download Node, libmpv, and Koffi's Windows binary into `.local/`. Each download is checked against a SHA-256 digest (or npm integrity hash) written in the script, never against metadata fetched at the same time. Archives are cached in `.local/downloads` and re-hashed on every run; a mismatch means a fresh download. Comments in each script say how the pins were checked.

## Notices

After electron-builder copies the app, `scripts/release-notices.mjs` writes `resources/licenses/npm-packages.txt`. The build fails if a required notice is missing or a shipped package has a license nobody has reviewed. [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) lists everything the installers include.

## Checking a build

`npm run smoke:runtime -- <app dir>` starts the packaged audio process with the packaged Node. It checks that libmpv loads, decodes a generated WAV to the null output, and exits cleanly. Point it at `dist/win-unpacked`, or at `"/opt/Squiggly Music" --expect-system-libmpv` after installing the RPM.

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

Pushing a `v*` tag runs `.github/workflows/release.yml`. It typechecks, builds, and runs the unit tests (with real libmpv) and the Playwright interface tests. Then it builds the Windows installer and portable exe and the RPM, smoke-tests each package's audio runtime, and stops if anything fails. Last, it writes `SHA256SUMS`, adds build provenance attestations, and publishes a GitHub release. Versions with a hyphen, like `1.2.0-beta.1`, go out as prereleases.

To build without publishing, open Actions, pick Release, and choose Run workflow. The files end up in the `release-assets` artifact.

## Verifying a download

```bash
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify <file> -R parth-thakre/squiggly-music
```

On Windows, compare `(Get-FileHash <file> -Algorithm SHA256).Hash.ToLower()` with the line in `SHA256SUMS`.

The attestation shows the release workflow built the file from the tagged commit. The Windows builds aren't code-signed yet.
