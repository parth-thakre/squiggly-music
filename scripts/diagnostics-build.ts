// Remote diagnostics (apps/desktop/main/remoteDiagnostics.ts) are for beta builds only. A build
// gets them when SQUIGGLY_DIAG_URL and SQUIGGLY_DIAG_TOKEN are both set, and only if package.json's
// version is a prerelease (0.3.0-beta.1). A stable version with either one set fails the build, so
// a stable release can't be made with diagnostics in it (docs/packaging.md, "Beta builds").

export interface DiagnosticsTarget { url: string; token: string }

// A prerelease has a hyphen before any build metadata: 0.3.0-beta.1 does, 0.3.0 and 0.3.0+ci-7 don't.
export const isPrerelease = (version: string) => version.split('+')[0].includes('-');

// The collector's URL and token for this build, or null for a build without diagnostics. Empty
// values count as unset, so CI can pass an empty secret for a stable tag. Throws on a stable
// version, on only one of the two, and on a URL that isn't http(s).
export function diagnosticsTarget(env: Record<string, string | undefined>, version: string): DiagnosticsTarget | null {
  const url = env.SQUIGGLY_DIAG_URL?.trim() ?? '';
  const token = env.SQUIGGLY_DIAG_TOKEN?.trim() ?? '';
  if (!url && !token) return null;
  if (!isPrerelease(version)) {
    throw new Error(`Diagnostics are for beta builds only. package.json's version ${version} is a stable one, so this build can't have SQUIGGLY_DIAG_URL or SQUIGGLY_DIAG_TOKEN. Unset them, or build a prerelease version such as ${version}-beta.1.`);
  }
  if (!url || !token) throw new Error('Set both SQUIGGLY_DIAG_URL and SQUIGGLY_DIAG_TOKEN for a diagnostics build, or neither.');
  let target: URL;
  try { target = new URL(url); } catch { throw new Error(`SQUIGGLY_DIAG_URL isn't a URL: ${url}`); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('SQUIGGLY_DIAG_URL must be an http(s) URL.');
  return { url, token };
}
