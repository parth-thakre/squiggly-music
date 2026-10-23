# Signing Windows releases

Windows releases are signed through SignPath Foundation, which signs open source projects for free. [CODE_SIGNING.md](../CODE_SIGNING.md) is the public policy it asks for. Signing doesn't skip Windows' SmartScreen warning on day one: SmartScreen trusts a certificate as signed releases are downloaded and run. What it changes right away is the publisher Windows shows, and how antivirus treats the files.

## How a release is signed

`.github/workflows/release.yml` signs a release in two passes, because the installer can't be opened up and signed inside afterwards. The passes are split into jobs so the SignPath token never reaches a runner that ran `npm ci` or any of this repository's code:

1. `windows` builds the app and smoke-tests it. This builds unsigned installers too, because electron-builder only writes `resources/app-update.yml`, the updater's settings, into the app when it builds the NSIS installer.
2. `windows-sign-app` sends the app to SignPath, which signs `Squiggly Music.exe` and `libmpv-2.dll` (artifact configuration `app`).
3. `windows-installers` checks those signatures and builds the installer and portable exe from the signed app (`electron-builder --prepackaged`).
4. `windows-sign-installers` sends those two to SignPath (artifact configuration `installers`).
5. `windows-release` rebuilds `latest.yml` and the installer's block map, since signing changed the installer (`scripts/rehash-windows-update.mjs`), and checks every signature.

Every signature check requires a valid signature from a certificate whose subject is exactly `SIGNPATH_EXPECTED_SUBJECT` (see below).

The two signing jobs check nothing out and install nothing. They hand SignPath a workflow artifact the job before uploaded, and upload what SignPath sends back for the job after.

Each request waits up to an hour for someone to approve it in SignPath, so a release takes two approvals.

Only release tags (`v*`) are signed, and every release tag must be. A manual run of the workflow from a branch builds the same files unsigned, for testing only. Once signing is set up, don't publish an unsigned Windows build: `win.signtoolOptions.publisherName` in `electron-builder.yml` goes into the app's `resources/app-update.yml`, and electron-updater only installs an update whose signer's common name is `SignPath Foundation`. An unsigned installer would fail that check on every installed copy. So a tag build fails straight away if the `SIGNPATH_ORGANIZATION_ID` variable is unset, and the signing job fails if the `SIGNPATH_API_TOKEN` secret is. Before signing is set up, no release can be cut.

`windows-installers` also checks that `app-update.yml` names the signing certificate's common name as a publisher. If the certificate ever changes names, change `publisherName` and `SIGNPATH_EXPECTED_SUBJECT` together, and remember that copies already installed only accept the old name.

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
   - Only if the certificate's subject differs from `CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US`, add the variable `SIGNPATH_EXPECTED_SUBJECT` with the subject exactly as Windows shows it (`(Get-AuthenticodeSignature <file>).SignerCertificate.Subject`). The workflow fails if any signed file has another subject, which catches files signed with some other certificate. The default is what SignPath Foundation's current certificate shows; SignPath's own documentation only says it is issued to SignPath Foundation, so check it against the first signed release.
5. Under Settings › Rules › Rulesets, add a tag ruleset for `v*` that restricts creations, updates, and deletions, with only maintainers allowed to bypass it. Anyone who can push a `v*` tag can start a signing request.

The token is only given to the two signing jobs, never to a job that builds.

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
