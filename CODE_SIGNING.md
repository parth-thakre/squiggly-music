# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Signing starts once this project's SignPath Foundation application is approved. Until then, releases are unsigned; their SHA-256 checksums and GitHub build attestations are published with every release either way.

## What gets signed

Only the Windows files built by this repository's release workflow, from this repository's source:

- `Squiggly Music.exe`, the application
- `libmpv-2.dll`, built from source in the workflow's `libmpv` job
- `Squiggly-Music-<version>-windows-x64-setup.exe`, the installer
- `Squiggly-Music-<version>-windows-x64-portable.exe`, the portable app

Third-party files inside the app are left as their projects shipped them. `node.exe` carries the OpenJS Foundation's own signature.

Nothing built on a personal machine is signed. Signing requests come only from `.github/workflows/release.yml` in [parth-thakre/squiggly-music](https://github.com/parth-thakre/squiggly-music), the official repository.

## Team

- Committers and reviewers: [Parth Thakre](https://github.com/parth-thakre)
- Approvers: [Parth Thakre](https://github.com/parth-thakre)

Every signing request is approved by hand in SignPath. Team members use multi-factor authentication for GitHub and SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Squiggly talks to the Navidrome or OpenSubsonic server you connect it to. It looks up lyrics on lrclib.net only if you turn that on in Settings. It doesn't check for updates or send analytics.
