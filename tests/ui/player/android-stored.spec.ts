import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// The Android app's kept library answers (apps/android/web/stored.ts), in a real browser's
// IndexedDB: the WebView has the same one. No server or page of the app is needed.
const source = buildSync({ entryPoints: [resolve('apps/android/web/stored.ts')], bundle: true, write: false, format: 'iife', globalName: 'stored' }).outputFiles[0].text;
type Answers = { bind(account: string): void; read(key: string): Promise<unknown>; write(key: string, value: unknown): Promise<void>; clear(): Promise<void> };
declare const stored: { createAnswers(): Answers };

test.beforeEach(async ({ page }) => {
  await page.route('http://answers.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>answers</title>' }));
  await page.goto('http://answers.test/');
  await page.addScriptTag({ content: source });
});

test('an account switch whose clearing fails shows the new account none of the last one\'s answers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const answers = stored.createAnswers();
    answers.bind('server\nada');
    await answers.write('genres\n[]', ['Ada\'s genres']);
    const before = await answers.read('genres\n[]');
    // The switch's clearing (the one transaction writing the owner) is aborted.
    const original = IDBDatabase.prototype.transaction;
    let aborted = false;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const transaction = original.apply(this, args);
      const [names, mode] = args;
      if (!aborted && mode === 'readwrite' && Array.isArray(names) && names.includes('meta')) { aborted = true; queueMicrotask(() => transaction.abort()); }
      return transaction;
    };
    answers.bind('server\nbea');
    const after = await answers.read('genres\n[]');
    await answers.write('genres\n[]', ['Bea\'s genres']);
    IDBDatabase.prototype.transaction = original;
    // Signed in as Ada again: hers are still hers, and nothing of Bea's was written over them.
    answers.bind('server\nada');
    return { before, after, aborted, again: await answers.read('genres\n[]') };
  });
  expect(result.aborted).toBe(true);
  expect(result.before).toEqual(['Ada\'s genres']);
  expect(result.after).toBeUndefined();
  expect(result.again).toEqual(['Ada\'s genres']);
});

test('answers past the limit go when the account is bound, however short each session was', async ({ page }) => {
  const count = await page.evaluate(async () => {
    for (let launch = 0; launch < 24; launch++) {
      const answers = stored.createAnswers();
      answers.bind('server\nada');
      for (let i = 0; i < 90; i++) await answers.write(`album\n["${launch}-${i}"]`, { album: {}, tracks: [] });
    }
    // One more launch: binding trims.
    const answers = stored.createAnswers();
    answers.bind('server\nada');
    await answers.read('genres\n[]');
    const db = await new Promise<IDBDatabase>((done, fail) => { const asked = indexedDB.open('squiggly-library', 1); asked.onsuccess = () => done(asked.result); asked.onerror = () => fail(asked.error); });
    return new Promise<number>((done, fail) => { const asked = db.transaction('answers').objectStore('answers').count(); asked.onsuccess = () => done(asked.result); asked.onerror = () => fail(asked.error); });
  });
  expect(count).toBe(2000);
});
