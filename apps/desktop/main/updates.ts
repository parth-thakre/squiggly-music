import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../../../packages/core/contracts';

// Updates from this project's GitHub releases, as described by resources/app-update.yml (written
// by electron-builder from the publish block) and each release's latest.yml. electron-updater
// checks every download against the SHA-512 in latest.yml.
// - install: the installed Windows app downloads the new installer in the background and runs it
//   on Restart to update, or quietly when the app quits.
// - notify: the portable exe and the Linux packages (RPM, deb, AppImage) can't replace
//   themselves safely (the portable would become an installed copy; the RPM and deb would need
//   root; an AppImage could replace its own file, but doing that unsigned and untested is left
//   for later), so they only say a version is out. So do the macOS builds: electron-updater
//   installs through Squirrel.Mac, which needs a signed app, and they are unsigned. Their
//   latest-mac.yml gives only the version.
// - off: development builds, which have no release to compare with, and a Flatpak, which its
//   store updates.
const RELEASES = 'https://github.com/parth-thakre/squiggly-music/releases';
const FIRST_CHECK = 10_000;
const EVERY = 6 * 60 * 60 * 1000;

export function updateMode(): UpdateState['mode'] {
  if (!app.isPackaged) return 'off';
  if (process.env.FLATPAK_ID) return 'off';
  return process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR ? 'install' : 'notify';
}
export const initialUpdateState = (): UpdateState => ({
  mode: updateMode(), status: 'idle', current: app.getVersion(), version: null, percent: null, error: null,
});

export class Updates {
  private updater: typeof electronUpdater.autoUpdater | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  // report: diagnostics builds' raw updater events (remoteDiagnostics.ts), errors included.
  constructor(
    private state: () => UpdateState, private set: (state: UpdateState) => void, private enabled: () => boolean,
    private report: (event: string, data?: Record<string, unknown>) => void = () => undefined,
  ) {}

  private patch(changes: Partial<UpdateState>) { this.set({ ...this.state(), ...changes }); }

  start() {
    this.report('start', { mode: this.state().mode, current: this.state().current });
    if (this.state().mode === 'off') return;
    const updater = this.updater = electronUpdater.autoUpdater;
    updater.autoDownload = this.state().mode === 'install';
    // Installing on quit goes through installOnQuit, from the app's own quit sequence.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = null;
    let decile = -1;
    updater.on('checking-for-update', () => { this.report('checking'); this.patch({ status: 'checking', error: null }); });
    updater.on('update-not-available', info => { this.report('not-available', { version: info.version }); this.patch({ status: 'up-to-date', version: null, percent: null }); });
    updater.on('update-available', info => {
      this.report('available', { version: info.version, releaseDate: info.releaseDate }); decile = -1;
      this.patch({ status: this.state().mode === 'install' ? 'downloading' : 'available', version: info.version, percent: null });
    });
    updater.on('download-progress', progress => {
      if (Math.floor(progress.percent / 10) !== decile) { decile = Math.floor(progress.percent / 10); this.report('progress', { percent: Math.round(progress.percent), bytesPerSecond: progress.bytesPerSecond, total: progress.total }); }
      this.patch({ percent: Math.round(progress.percent) });
    });
    updater.on('update-downloaded', info => { this.report('downloaded', { version: info.version }); this.patch({ status: 'ready', version: info.version, percent: null }); });
    // electron-updater's messages can carry URLs and paths, so only a plain one is shown.
    updater.on('error', (error, message) => {
      this.report('error', { message: error?.message ?? null, detail: message ?? null, stack: error?.stack ?? null });
      this.patch({ status: this.state().status === 'ready' ? 'ready' : 'error', error: 'Couldn\'t reach GitHub to check for updates.', percent: null });
    });
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK), setInterval(() => this.check(), EVERY));
  }

  // Scheduled checks respect the setting; one asked for by hand always runs.
  check(asked = false) {
    const status = this.state().status;
    if (!this.updater || (!asked && !this.enabled()) || status === 'checking' || status === 'downloading' || status === 'ready') {
      this.report('check-skipped', { asked, status, updater: this.updater !== null, enabled: this.enabled() });
      return;
    }
    this.report('check', { asked });
    void this.updater.checkForUpdates().catch(error => this.report('check-failed', { message: error instanceof Error ? error.message : String(error) }));
  }

  // Restart to update: runs the downloaded installer, which starts the app again when it's done.
  installNow() {
    if (!this.updater || this.state().status !== 'ready') return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }
  // Quitting with an update downloaded installs it quietly, without starting the app again.
  installOnQuit() {
    if (this.updater && this.state().mode === 'install' && this.state().status === 'ready') this.updater.quitAndInstall(true, false);
  }

  releaseUrl() {
    const version = this.state().version;
    return version ? `${RELEASES}/tag/v${version}` : `${RELEASES}/latest`;
  }

  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
}
