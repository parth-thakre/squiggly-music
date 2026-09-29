## Install

Download the file for your system from **Assets** below, or with the GitHub CLI:

```bash
gh release download {{TAG}} -R {{REPO}}
```

- **Windows 10/11 (x64):** run `Squiggly-Music-{{VERSION}}-windows-x64-setup.exe`. To run without installing, use `Squiggly-Music-{{VERSION}}-windows-x64-portable.exe`. The builds are not code-signed yet, so SmartScreen may warn: choose **More info**, then **Run anyway**.
- **Fedora (x86_64):** `sudo dnf install ./squiggly-music-{{VERSION}}.x86_64.rpm`. dnf also installs `mpv-libs`, the libmpv runtime the player needs.
- **macOS 13 or later (Apple silicon or Intel):** open `Squiggly-Music-{{VERSION}}-macos-arm64.zip` or `Squiggly-Music-{{VERSION}}-macos-x64.zip`, move Squiggly Music to Applications, and run `brew install mpv` for the libmpv it plays through. The app is not signed: on macOS 15 and later, open it once, then choose **Open Anyway** in System Settings, Privacy & Security; on earlier versions, Control-click it and choose **Open**. It is built on Linux and not yet tested on a Mac.
- **Android 7 or later:** open `Squiggly-Music-{{VERSION}}-android.apk` on the phone and allow your file manager to install apps when Android asks.

## Verify

`SHA256SUMS` lists the SHA-256 of every asset. On Linux, from the download folder:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

On Windows (PowerShell), compare the output with the matching line in `SHA256SUMS`:

```powershell
(Get-FileHash .\Squiggly-Music-{{VERSION}}-windows-x64-setup.exe -Algorithm SHA256).Hash.ToLower()
```

On macOS, check one file's line with `shasum`:

```bash
grep ' Squiggly-Music-{{VERSION}}-macos-arm64.zip$' SHA256SUMS | shasum -a 256 -c
```

<!-- attestation:start -->
Each asset also has a signed build provenance attestation. It shows that this repository's release workflow built the file from tag `{{TAG}}`:

```bash
gh attestation verify squiggly-music-{{VERSION}}.x86_64.rpm -R {{REPO}}
```
<!-- attestation:end -->


## Third-party software

The packages include third-party software under their own licenses. The notices are installed in `resources/licenses/` inside the app directory (`Contents/Resources/licenses/` in the macOS app); see [THIRD-PARTY-NOTICES.md](https://github.com/{{REPO}}/blob/{{TAG}}/THIRD-PARTY-NOTICES.md). The Windows packages include an audio-only build of libmpv, licensed under the LGPL version 2.1 or later. `Squiggly-Music-{{VERSION}}-libmpv-windows-x64-source.tar` below holds its complete source and build recipe; see [licenses/libmpv-windows/NOTICE.md](https://github.com/{{REPO}}/blob/{{TAG}}/licenses/libmpv-windows/NOTICE.md). The macOS and Fedora packages carry no libmpv; they use the one your system provides.
