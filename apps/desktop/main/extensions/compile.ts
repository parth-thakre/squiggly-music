import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

// Whether `path` is `root` or inside it. Both should already have their symlinks followed.
export function within(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

// Every other import is resolved as esbuild would, then refused unless the file really is inside
// the extension's folder, after following symlinks. The loaders inline text, JSON, and images, so
// without this an import could copy any readable file into the bundle.
function folderOnly(dir: string): Plugin {
  return {
    name: 'squiggly-folder-only',
    setup(build) {
      // The folder's own name isn't followed, so a folder that is itself a link holds nothing.
      let root: Promise<string> | undefined;
      const inside = async (path: string) => {
        const real = await realpath(path).catch(() => null);
        root ??= realpath(dirname(resolve(dir))).then(parent => join(parent, basename(resolve(dir))));
        return real !== null && within(await root, real);
      };
      const refuse = (path: string) => ({ errors: [{ text: `“${path}” is outside the extension's folder. An extension can only use files inside its own folder.` }] });
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === folderOnly) return undefined;
        const found = await build.resolve(args.path, {
          kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, with: args.with, pluginData: folderOnly,
        });
        if (found.errors.length) return { errors: found.errors };
        if (found.external || found.namespace !== 'file' || !found.path) return found;
        return await inside(found.path) ? found : refuse(args.path);
      });
      // Glob imports such as import(`../${name}.txt`) skip onResolve, so every file is checked
      // again before it's read.
      build.onLoad({ filter: /.*/, namespace: 'file' }, async args => await inside(args.path) ? undefined : refuse(args.path));
    },
  };
}

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
      plugins: [hostModules, folderOnly(dir)],
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
