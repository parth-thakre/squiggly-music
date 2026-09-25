## Install

Download the file for your system from **Assets** below, or with the GitHub CLI:

```bash
gh release download {{TAG}} -R {{REPO}}
```

- **Windows 10/11 (x64):** run `Squiggly-Music-{{VERSION}}-windows-x64-setup.exe`. To run without installing, use `Squiggly-Music-{{VERSION}}-windows-x64-portable.exe`. The builds are not code-signed yet, so SmartScreen may warn: choose **More info**, then **Run anyway**.
- **Fedora (x86_64):** `sudo dnf install ./squiggly-music-{{VERSION}}.x86_64.rpm`. dnf also installs `mpv-libs`, the libmpv runtime the player needs.

## Verify

`SHA256SUMS` lists the SHA-256 of every asset. On Linux, from the download folder:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

On Windows (PowerShell), compare the output with the matching line in `SHA256SUMS`:

```powershell
(Get-FileHash .\Squiggly-Music-{{VERSION}}-windows-x64-setup.exe -Algorithm SHA256).Hash.ToLower()
```

<!-- attestation:start -->
Each asset also has a signed build provenance attestation. It shows that this repository's release workflow built the file from tag `{{TAG}}`:

```bash
gh attestation verify squiggly-music-{{VERSION}}.x86_64.rpm -R {{REPO}}
```
<!-- attestation:end -->


## Third-party software

The packages include third-party software under their own licenses. The notices are installed in `resources/licenses/` inside the app directory; see [THIRD-PARTY-NOTICES.md](https://github.com/{{REPO}}/blob/{{TAG}}/THIRD-PARTY-NOTICES.md). The Windows packages include libmpv, licensed under the GPL version 3 or later. Its source links and written source offer are in [licenses/libmpv-windows/NOTICE.md](https://github.com/{{REPO}}/blob/{{TAG}}/licenses/libmpv-windows/NOTICE.md).
