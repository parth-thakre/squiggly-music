# Installing

Download a build from [Releases](https://github.com/parth-thakre/squiggly-music/releases), along with `SHA256SUMS` from the same release, and check it:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

## Windows

Run the setup program (`-windows-x64-setup.exe`) or the portable exe. They aren't signed yet, so SmartScreen will warn you. Choose More info, then Run anyway.

## Linux

- Fedora: `sudo dnf install ./squiggly-music-<version>.x86_64.rpm` installs Squiggly and pulls in `mpv-libs`.
- Debian and Ubuntu: `sudo apt install ./squiggly-music_<version>_amd64.deb` installs Squiggly and pulls in `libmpv2` (`libmpv1` on Ubuntu 22.04).
- Anything else: make `Squiggly-Music-<version>-x86_64.AppImage` executable (`chmod +x`) and run it. It doesn't include libmpv, so install your distribution's (`libmpv2` on Debian and Ubuntu, `mpv-libs` on Fedora, `mpv` on Arch). Without one, the player says which to install. It needs FUSE 2 (`libfuse2`) to start, or run it with `--appimage-extract-and-run`.

Fedora 45's and Ubuntu 26.04's libmpv 0.41 have been tested. Debian and older Ubuntu ship older versions.

## macOS 13 or later

The Mac builds are made on Linux and haven't been tried on a Mac yet.

1. Open `Squiggly-Music-<version>-macos-arm64.zip` (Apple silicon) or `-macos-x64.zip` (Intel) and move Squiggly Music to Applications.
2. It plays through Homebrew's libmpv, so run `brew install mpv` too.
3. The app isn't signed. On macOS 15 and later, open it once, then choose Open Anyway in System Settings › Privacy & Security. On earlier versions, Control-click it and choose Open.

To check the download on a Mac, use `shasum`:

```bash
grep ' Squiggly-Music-.*-macos-arm64.zip$' SHA256SUMS | shasum -a 256 -c
```

## Android 7 or later

The Android app is in beta on the [0.3.0-beta.4 pre-release](https://github.com/parth-thakre/squiggly-music/releases/tag/v0.3.0-beta.4). Open `Squiggly-Music-0.3.0-beta.4-android.apk` on the phone and allow your file manager to install apps when Android asks. [android.md](android.md) covers building and signing the APK yourself.

## Connecting

Enter your Navidrome address with any port or subpath (`music.example.com/navidrome` works), your username, and your password. Without `https://` or `http://`, Squiggly tries HTTPS and asks before using plain HTTP.

Squiggly remembers the sign-in and reconnects at launch. It keeps the password only as your system encrypts it: Windows' user-account encryption, the macOS Keychain, the Linux keyring, or the Android Keystore. Without one, it keeps the password in memory for the session only. Disconnecting in Settings forgets it.

## Updates

Squiggly checks this repository's releases for a newer version at launch and every six hours. Nothing about you is sent, and Settings › Updates turns the check off.

The installed Windows app downloads a new version in the background and installs it when you restart or quit. The portable exe, the Mac builds, the RPM, the deb, and the AppImage can't replace themselves, so they say a new version is out and link to it.
