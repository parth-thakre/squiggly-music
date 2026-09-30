import { describe, expect, it } from 'vitest';
import { diagnosticsTarget, isPrerelease } from '../scripts/diagnostics-build';

// The build's rule (electron.vite.config.ts): diagnostics only in prerelease versions.
describe('diagnostics build guard', () => {
  const url = 'http://pc.tail1e2a66.ts.net:47800/ingest';

  it('tells prerelease versions from stable ones', () => {
    for (const version of ['0.3.0-beta.1', '1.0.0-rc.2', '0.2.1-alpha', '1.0.0-beta+ci.4']) expect(isPrerelease(version)).toBe(true);
    for (const version of ['0.2.0', '1.0.0', '1.0.0+ci-7']) expect(isPrerelease(version)).toBe(false);
  });

  it('builds without diagnostics when neither variable is set, stable or beta', () => {
    expect(diagnosticsTarget({}, '0.2.0')).toBeNull();
    expect(diagnosticsTarget({}, '0.3.0-beta.1')).toBeNull();
    // CI passes empty values for stable tags.
    expect(diagnosticsTarget({ SQUIGGLY_DIAG_URL: '', SQUIGGLY_DIAG_TOKEN: ' ' }, '0.2.0')).toBeNull();
  });

  it('fails a stable build that has either variable', () => {
    for (const env of [{ SQUIGGLY_DIAG_URL: url, SQUIGGLY_DIAG_TOKEN: 'tok' }, { SQUIGGLY_DIAG_URL: url }, { SQUIGGLY_DIAG_TOKEN: 'tok' }]) {
      expect(() => diagnosticsTarget(env, '0.2.0')).toThrow(/^Diagnostics are for beta builds only\. package\.json's version 0\.2\.0 is a stable one/);
      expect(() => diagnosticsTarget(env, '1.0.0+ci-7')).toThrow(/beta builds only/);
    }
  });

  it('takes a hostname URL and the token for a beta', () => {
    expect(diagnosticsTarget({ SQUIGGLY_DIAG_URL: ` ${url} `, SQUIGGLY_DIAG_TOKEN: 'tok\n' }, '0.3.0-beta.1')).toEqual({ url, token: 'tok' });
    expect(diagnosticsTarget({ SQUIGGLY_DIAG_URL: 'https://100.72.88.79/ingest', SQUIGGLY_DIAG_TOKEN: 'tok' }, '0.3.0-rc.1')?.url).toBe('https://100.72.88.79/ingest');
  });

  it('fails a beta with only one variable, or a URL that is not http(s)', () => {
    expect(() => diagnosticsTarget({ SQUIGGLY_DIAG_URL: url }, '0.3.0-beta.1')).toThrow('Set both');
    expect(() => diagnosticsTarget({ SQUIGGLY_DIAG_TOKEN: 'tok' }, '0.3.0-beta.1')).toThrow('Set both');
    expect(() => diagnosticsTarget({ SQUIGGLY_DIAG_URL: 'pc.tail1e2a66.ts.net:47800', SQUIGGLY_DIAG_TOKEN: 'tok' }, '0.3.0-beta.1')).toThrow('http(s)');
    expect(() => diagnosticsTarget({ SQUIGGLY_DIAG_URL: 'not a url', SQUIGGLY_DIAG_TOKEN: 'tok' }, '0.3.0-beta.1')).toThrow("isn't a URL");
  });
});
