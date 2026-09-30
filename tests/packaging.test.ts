import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// js-yaml comes with electron-updater, a production dependency, and has no type declarations here.
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): any };
const read = (path: string) => readFileSync(path, 'utf8');
const builder = load(read('electron-builder.yml'));
const flatpak = load(read('build/flatpak/dev.squiggly.music.yml'));

describe('Linux packages', () => {
  it('builds an RPM, a deb, and an AppImage for x64', () => {
    expect(builder.linux.target).toEqual([{ target: 'rpm', arch: 'x64' }, { target: 'deb', arch: 'x64' }, { target: 'AppImage', arch: 'x64' }]);
    expect(builder.deb.artifactName).toBe('squiggly-music_${version}_amd64.${ext}');
    expect(builder.appImage.artifactName).toBe('Squiggly-Music-${version}-x86_64.${ext}');
  });

  it('depends on the distribution\'s libmpv and never ships one', () => {
    expect(builder.rpm.depends).toContain('mpv-libs');
    expect(builder.deb.depends).toContain('libmpv2 | libmpv1');
    expect(builder.deb.depends.join(' ')).not.toContain('mpv-libs');
    const shipped = JSON.stringify([builder.linux.extraResources, builder.linux.files, builder.extraResources]);
    expect(shipped).not.toMatch(/libmpv/);
  });
});

describe('Flatpak manifest', () => {
  const sources = JSON.parse(read('build/libmpv/sources.json')).sources as { url: string; sha256: string }[];
  it('names the app the way the desktop file, the metainfo, and electron-builder do', () => {
    expect(flatpak['app-id']).toBe(builder.appId);
    expect(read('build/flatpak/dev.squiggly.music.metainfo.xml')).toContain(`<id>${flatpak['app-id']}</id>`);
    expect(read('build/flatpak/dev.squiggly.music.desktop')).toMatch(/^Icon=dev\.squiggly\.music$/m);
    expect(flatpak.command).toBe('squiggly-music.sh');
  });
  it('lists this version as the newest release in the metainfo', () => {
    const version = JSON.parse(read('package.json')).version;
    expect(/<release version="([^"]+)"/.exec(read('build/flatpak/dev.squiggly.music.metainfo.xml'))?.[1]).toBe(version);
  });
  it('pins every downloaded source by SHA-256, and libmpv\'s to the sources the Windows build uses', () => {
    const archives = flatpak.modules.flatMap((module: any) => module.sources).filter((source: any) => source.type === 'archive');
    expect(archives.length).toBeGreaterThan(0);
    for (const source of archives) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sources.find(known => known.url === source.url)?.sha256).toBe(source.sha256);
    }
  });
  it('builds libmpv without the GPL, and uses the app\'s own Node', () => {
    const mpv = flatpak.modules.find((module: any) => module.name === 'mpv');
    expect(mpv['config-opts']).toEqual(expect.arrayContaining(['-Dgpl=false', '-Dlibmpv=true', '-Dcplayer=false']));
    const ffmpeg = flatpak.modules.find((module: any) => module.name === 'ffmpeg');
    expect(ffmpeg['config-opts']).not.toEqual(expect.arrayContaining(['--enable-gpl']));
    expect(ffmpeg['config-opts']).not.toEqual(expect.arrayContaining(['--enable-version3']));
    expect(ffmpeg['config-opts']).not.toEqual(expect.arrayContaining(['--enable-nonfree']));
    expect(flatpak['finish-args']).toContain('--env=SQUIGGLY_LIBMPV_PATH=/app/lib/libmpv.so.2');
  });
});
