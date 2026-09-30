import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { API_VERSION } from '../../../../packages/extension-api/index';
import { readJson } from '../config';
import { within } from './compile';

// package.json, the "squiggly" field:
//   { "renderer": "src/index.ts", "displayName"?: "…", "description"?: "…", "apiVersion"?: 1 }
export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string | null;
  // An absolute path inside the extension's folder.
  renderer: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Parsed<Manifest> => ({ ok: false, error });
const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;

// Registry owners are lowercase names without colons (see renderer registry.ts). A scoped
// package name "@scope/name" becomes "scope.name".
const OWNER = /^[a-z][a-z0-9._-]*$/;
// The app's own owners: built-in commands and menu items, and theme files in the config folder.
const RESERVED = ['builtin', 'user'];
export function extensionId(packageName: string): Parsed<string> {
  const id = packageName.trim().toLowerCase().replace(/^@/, '').replace('/', '.');
  if (!id || id.length > 100 || !OWNER.test(id)) {
    return { ok: false, error: `“${packageName}” can't be used as an extension id. Use a lowercase name that starts with a letter, like "sleep-timer".` };
  }
  if (RESERVED.includes(id)) return { ok: false, error: `“${packageName}” is a name the app uses for itself. Give the extension another name.` };
  return { ok: true, value: id };
}

export async function readManifest(dir: string): Promise<Parsed<Manifest>> {
  // A link could point anywhere, so the folder itself must be a real folder.
  if ((await lstat(dir).catch(() => null))?.isSymbolicLink()) return fail('This is a link to another folder. Move or copy the extension itself into the extensions folder.');
  const read = await readJson(join(dir, 'package.json'), 'package.json');
  if (!read) return fail('The folder has no package.json.');
  if ('error' in read) return fail(read.error);
  const pkg = read.value as Record<string, unknown> | null;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return fail('package.json must be an object.');
  const squiggly = pkg.squiggly as Record<string, unknown> | undefined;
  if (!squiggly || typeof squiggly !== 'object' || Array.isArray(squiggly)) return fail('This is not a Squiggly extension: package.json has no "squiggly" field.');
  const packageName = text(pkg.name, 214) ?? basename(dir);
  const id = extensionId(packageName);
  if (!id.ok) return fail(id.error);
  if (squiggly.apiVersion !== undefined && (typeof squiggly.apiVersion !== 'number' || squiggly.apiVersion > API_VERSION)) {
    return fail(`This extension needs extension API ${String(squiggly.apiVersion)}; this version of Squiggly has API ${API_VERSION}. Update Squiggly.`);
  }
  const entry = squiggly.renderer;
  if (typeof entry !== 'string' || !entry.trim()) return fail('Add "renderer": "src/index.ts" (the path to your entry) to the "squiggly" field in package.json.');
  const renderer = resolve(dir, entry);
  const inside = relative(dir, renderer);
  const outside = 'squiggly.renderer must point inside the extension\'s folder.';
  if (isAbsolute(entry) || !inside || inside.startsWith('..') || isAbsolute(inside)) return fail(outside);
  // Checked again with symlinks followed. A missing entry is left to the compiler to report.
  const real = await realpath(renderer).catch(() => null);
  if (real && !within(await realpath(dir), real)) return fail(outside);
  return { ok: true, value: {
    id: id.value, name: text(squiggly.displayName, 80) ?? packageName,
    version: text(pkg.version, 64) ?? '0.0.0',
    description: text(squiggly.description, 400) ?? text(pkg.description, 400),
    renderer,
  } };
}
