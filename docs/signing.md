# Signing Windows releases

Windows releases are signed through SignPath Foundation, which signs open source projects for free. [CODE_SIGNING.md](../CODE_SIGNING.md) is the public policy it asks for. Signing doesn't skip Windows' SmartScreen warning on day one: SmartScreen trusts a certificate as signed releases are downloaded and run. What it changes right away is the publisher Windows shows, and how antivirus treats the files.

## How a release is signed

The Windows job in `.github/workflows/release.yml` builds in two passes, because the installer can't be opened up and signed inside afterwards:

1. It builds the app and smoke-tests it. This builds unsigned installers too, because electron-builder only writes `resources/app-update.yml`, the updater's settings, into the app when it builds the NSIS installer.
2. It sends the app to SignPath, which signs `Squiggly Music.exe` and `libmpv-2.dll` (artifact configuration `app`).
3. It builds the installer and portable exe from the signed app (`electron-builder --prepackaged`).
4. It sends those two to SignPath (artifact configuration `installers`).
5. It rebuilds `latest.yml` and the installer's block map, since signing changed the installer (`scripts/rehash-windows-update.mjs`), and checks every signature.

Each request waits up to an hour for someone to approve it in SignPath, so a release takes two approvals.

Only release tags (`v*`) are signed. A manual run of the workflow from a branch builds the same files unsigned. Every signing step is also skipped while the `SIGNPATH_ORGANIZATION_ID` repository variable is unset, and the release comes out unsigned.

## Setting it up

1. Turn on two-factor authentication on GitHub.
2. Apply through [signpath.org](https://signpath.org). Link CODE_SIGNING.md as the code signing policy.
3. Once approved, in SignPath:
   - Add the GitHub Actions trusted build system to the project, with the slug `squiggly-music`.
   - Use the signing policy SignPath Foundation sets up, and check its slug is `release-signing`.
   - In the signing policy, turn on Verify origin and set Allowed branch names to the release tags only (`refs/tags/v*`), so SignPath refuses a request from any other ref even if the workflow is changed. SignPath's documentation only gives branch examples, so check the branch it records on the first signing request and adjust the pattern if it names tags differently.
   - Add the two artifact configurations below.
   - Create an API token for a CI user that can submit signing requests to the project.
4. In the GitHub repository, under Settings › Secrets and variables › Actions:
   - Add the variable `SIGNPATH_ORGANIZATION_ID`, your SignPath organization ID.
   - Add the secret `SIGNPATH_API_TOKEN`, the CI user's API token.
5. Under Settings › Rules › Rulesets, add a tag ruleset for `v*` that restricts creations, updates, and deletions, with only maintainers allowed to bypass it. Anyone who can push a `v*` tag can start a signing request.

The token is only given to the two signing steps, never to the build.

### Artifact configuration `app`

The unpacked app, as the workflow uploads it.

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Squiggly Music.exe">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="resources/runtime/libmpv-2.dll">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

### Artifact configuration `installers`

The installer and the portable exe. Each pattern must match exactly one file.

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Squiggly-Music-*-windows-x64-setup.exe">
      <authenticode-sign/>
    </pe-file>
    <pe-file path="Squiggly-Music-*-windows-x64-portable.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

## Not covered

The installer's uninstaller is built inside the installer, so it stays unsigned. electron-builder can only sign it through a signing hook that runs during the build, which would mean a third approval.
