// Builds the Android app. See docs/android.md for the toolchain it expects.
//
//   node scripts/android.mjs build      debug and release APKs into dist/android (npm run android:build)
//   node scripts/android.mjs debug      the debug APK only
//   node scripts/android.mjs release    the release APK only
//   node scripts/android.mjs keystore   make the release signing key, if there isn't one
//
// The JDK and SDK come from SQUIGGLY_ANDROID_HOME (default ~/.local/share/squiggly-android):
// its jdk/ and sdk/ unless JAVA_HOME and ANDROID_HOME say otherwise. Release signing reads
// SQUIGGLY_ANDROID_SIGNING, a properties file (default $SQUIGGLY_ANDROID_HOME/signing/release.properties).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'apps', 'android');
const home = process.env.SQUIGGLY_ANDROID_HOME ?? join(homedir(), '.local', 'share', 'squiggly-android');
const javaHome = process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'javac')) ? process.env.JAVA_HOME : join(home, 'jdk');
const androidHome = process.env.ANDROID_HOME ?? join(home, 'sdk');
const signing = process.env.SQUIGGLY_ANDROID_SIGNING ?? join(home, 'signing', 'release.properties');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const env = {
  ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome,
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? join(home, 'gradle'),
  PATH: [join(javaHome, 'bin'), join(androidHome, 'platform-tools'), process.env.PATH].join(':'),
};

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.status !== 0) { console.error(`${command} failed.`); process.exit(result.status ?? 1); }
}
function output(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) { process.stderr.write(result.stderr ?? ''); console.error(`${command} failed.`); process.exit(result.status ?? 1); }
  return result.stdout;
}
const bin = name => join(root, 'node_modules', '.bin', name);

function checkToolchain() {
  const missing = [[join(javaHome, 'bin', 'javac'), 'a JDK 21 (JAVA_HOME)'], [join(androidHome, 'platforms', 'android-36'), 'the Android SDK with platform 36 (ANDROID_HOME)']]
    .filter(([path]) => !existsSync(path)).map(([, what]) => what);
  if (missing.length) { console.error(`Missing ${missing.join(' and ')}. docs/android.md sets them up.`); process.exit(1); }
}

// Licences -----------------------------------------------------------------------------------
// The Android libraries the app ships, by Maven group, with licences reviewed by hand. An
// unreviewed group fails the build, as scripts/release-notices.mjs does for npm packages.
const MAVEN_LICENSES = [
  [/^androidx\./, 'Apache-2.0'], [/^org\.jetbrains\.kotlin$/, 'Apache-2.0'], [/^org\.jetbrains\.kotlinx$/, 'Apache-2.0'],
  [/^org\.jetbrains$/, 'Apache-2.0'], [/^com\.google\.guava$/, 'Apache-2.0'], [/^org\.jspecify$/, 'Apache-2.0'],
  [/^org\.apache\.cordova$/, 'Apache-2.0'], [/^com\.google\.errorprone$/, 'Apache-2.0'], [/^com\.google\.j2objc$/, 'Apache-2.0'],
];
function mavenLibraries() {
  const tree = output(join(project, 'gradlew'), ['-q', ':app:dependencies', '--configuration', 'releaseRuntimeClasspath'], { cwd: project });
  const found = new Map();
  for (const line of tree.split('\n')) {
    // "(c)" marks a version constraint, not a library in the app; "(*)" a repeat.
    const match = /--- ([\w.-]+):([\w.-]+):(.+)$/.exec(line);
    if (!match || line.endsWith('(c)')) continue;
    const [, group, artifact, versions] = match;
    // "1.2.0", "1.2.0 -> 1.3.0", or "{strictly 1.3.0} -> 1.3.0": the version after the last arrow.
    found.set(`${group}:${artifact}`, versions.replace(/ \(\*\)$/, '').split('->').at(-1).trim());
  }
  const unreviewed = [...found.keys()].filter(id => !MAVEN_LICENSES.some(([pattern]) => pattern.test(id.split(':')[0])));
  if (unreviewed.length) { console.error(`Review the licences of these Android libraries and add them to MAVEN_LICENSES: ${unreviewed.join(', ')}`); process.exit(1); }
  return [...found].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, resolved]) => `${id}:${resolved}  ${MAVEN_LICENSES.find(([pattern]) => pattern.test(id.split(':')[0]))[1]}`);
}
// Written into the page's assets, which Capacitor copies into the APK under assets/public/licenses.
function writeNotices(libraries) {
  const dir = join(project, 'app', 'src', 'main', 'assets', 'public', 'licenses');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE.squiggly.txt'));
  copyFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), join(dir, 'THIRD-PARTY-NOTICES.md'));
  writeFileSync(join(dir, 'android-libraries.txt'), [
    'Android libraries in this app (group:artifact:version  licence). Capacitor\'s Android',
    `library (@capacitor/android ${packageVersion('@capacitor/android')}) is MIT; its licence is in npm-packages.txt.`,
    'The Apache License 2.0 is in apache-2.0.txt.', '', ...libraries, '',
  ].join('\n'));
  copyFileSync(join(root, 'licenses', 'android', 'apache-2.0.txt'), join(dir, 'apache-2.0.txt'));
}
const packageVersion = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// Keystore -----------------------------------------------------------------------------------
function makeKeystore() {
  if (existsSync(signing)) { console.log(`Signing is already set up: ${signing}`); return; }
  const dir = dirname(signing);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = join(dir, 'squiggly-release.p12');
  if (existsSync(store)) { console.error(`${store} exists without ${signing}. Move it away or write the properties file by hand.`); process.exit(1); }
  // PKCS12 keeps one password for the store and the key.
  const password = randomBytes(24).toString('base64url');
  run(join(javaHome, 'bin', 'keytool'), ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-alias', 'squiggly', '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '10000', '-dname', 'CN=Squiggly Music, O=Squiggly Music', '-storepass:env', 'SQUIGGLY_STORE_PASSWORD'], { env: { ...env, SQUIGGLY_STORE_PASSWORD: password } });
  writeFileSync(signing, `storeFile=${store}\nstorePassword=${password}\nkeyAlias=squiggly\nkeyPassword=${password}\n`, { mode: 0o600 });
  chmodSync(store, 0o600);
  console.log(`Release key: ${store}\nSigning properties: ${signing}\nBack both up; an update must be signed with the same key.`);
}

// Build --------------------------------------------------------------------------------------
function build(kinds) {
  checkToolchain();
  run(bin('vite'), ['build', '--mode', 'android']);
  run(bin('cap'), ['sync', 'android']);
  writeNotices(mavenLibraries());
  const release = kinds.includes('release');
  const signed = release && existsSync(signing);
  if (release && !signed) console.warn(`\nNo signing properties at ${signing}; the release APK will be unsigned. Run: npm run android:keystore`);
  const tasks = kinds.map(kind => kind === 'debug' ? 'assembleDebug' : 'assembleRelease');
  run(join(project, 'gradlew'), ['--console=plain', ...tasks], { cwd: project, env: { ...env, ...(signed ? { SQUIGGLY_ANDROID_SIGNING: signing } : {}) } });

  const dist = join(root, 'dist', 'android');
  mkdirSync(dist, { recursive: true });
  const outputs = join(project, 'app', 'build', 'outputs', 'apk');
  const delivered = [];
  for (const kind of kinds) {
    const source = kind === 'debug' ? join(outputs, 'debug', 'app-debug.apk') : join(outputs, 'release', signed ? 'app-release.apk' : 'app-release-unsigned.apk');
    const name = `squiggly-${version}-${kind}${kind === 'release' && !signed ? '-unsigned' : ''}.apk`;
    for (const stale of readdirSync(dist).filter(file => file.startsWith(`squiggly-${version}-${kind}`))) rmSync(join(dist, stale));
    copyFileSync(source, join(dist, name));
    delivered.push(name);
  }
  const apksigner = join(androidHome, 'build-tools', readdirSync(join(androidHome, 'build-tools')).sort().at(-1), 'apksigner');
  for (const name of delivered.filter(file => !file.endsWith('-unsigned.apk'))) run(apksigner, ['verify', '--print-certs', join(dist, name)]);
  const sums = readdirSync(dist).filter(file => file.endsWith('.apk')).sort()
    .map(file => `${createHash('sha256').update(readFileSync(join(dist, file))).digest('hex')}  ${file}`);
  writeFileSync(join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  console.log(`\nAPKs in ${dist}:\n${sums.join('\n')}`);
}

const command = process.argv[2] ?? 'build';
if (command === 'keystore') { checkToolchain(); makeKeystore(); }
else if (command === 'build') build(['debug', 'release']);
else if (command === 'debug' || command === 'release') build([command]);
else { console.error(`Unknown command ${command}. Use build, debug, release, or keystore.`); process.exit(1); }
