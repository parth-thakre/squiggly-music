import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import type { Message, Plugin } from 'esbuild';

// Compiles an extension's renderer entry to one ES module with esbuild, bundling the
// extension's own dependencies. A few modules come from the app instead, so an extension shares
// the window's React (hooks break with two copies) and gets the API helpers without installing
// anything. Those resolve to `globalThis.__squigglyHost.modules[name]`, which the window's
// extension runtime fills in first.

export interface Bundle { code: string; hash: string; inputs: string[] }

export const HOST_MODULES: readonly string[] = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@squiggly/extension-api'];
export const HOST_GLOBAL = '__squigglyHost';

const hostModules: Plugin = {
  name: 'squiggly-host-modules',
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom|@squiggly\/extension-api)(\/.*)?$/ }, args => HOST_MODULES.includes(args.path)
      ? { path: args.path, namespace: 'squiggly-host' }
      : { errors: [{ text: `“${args.path}” isn't available to extensions. Use ${HOST_MODULES.join(', ')}.` }] });
    build.onLoad({ filter: /.*/, namespace: 'squiggly-host' }, args => ({
      loader: 'js',
      contents: `const host = globalThis.${HOST_GLOBAL};
if (!host || !(${JSON.stringify(args.path)} in host.modules)) throw new Error(${JSON.stringify(`Squiggly did not provide “${args.path}”.`)});
module.exports = host.modules[${JSON.stringify(args.path)}];`,
    }));
  },
};

// esbuild's messages as plain lines: "src/index.ts:3:10: Could not resolve "x"".
export function formatMessages(messages: readonly Message[], limit = 5): string {
  const lines = messages.slice(0, limit).map(message => {
    const where = message.location ? `${message.location.file}:${message.location.line}:${message.location.column + 1}: ` : '';
    return `${where}${message.text}`;
  });
  if (messages.length > limit) lines.push(`…and ${messages.length - limit} more.`);
  return lines.join('\n');
}

export async function compileEntry(entry: string, dir: string): Promise<Bundle> {
  const esbuild = await import('esbuild');
  let result: Awaited<ReturnType<typeof esbuild.build<{ write: false; metafile: true }>>>;
  try {
    result = await esbuild.build({
      entryPoints: [entry], absWorkingDir: dir, bundle: true, write: false, metafile: true, format: 'esm',
      platform: 'browser', target: 'chrome130',
      jsx: 'automatic', sourcemap: 'inline', sourcesContent: true, logLevel: 'silent', charset: 'utf8',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.css': 'text', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl', '.txt': 'text' },
      plugins: [hostModules],
    });
  } catch (error) {
    const failure = error as { errors?: Message[] };
    throw new Error(failure.errors?.length ? formatMessages(failure.errors) : error instanceof Error ? error.message : 'The extension could not be compiled.');
  }
  const code = result.outputFiles[0]?.text ?? '';
  // Inputs are what hot reload watches. Dependencies in node_modules aren't.
  const inputs = Object.keys(result.metafile.inputs)
    .filter(input => !input.includes(':'))
    .map(input => resolve(dir, input))
    .filter(input => !relative(dir, input).split(sep).includes('node_modules'));
  return { code, hash: createHash('sha256').update(code).digest('hex').slice(0, 16), inputs };
}
