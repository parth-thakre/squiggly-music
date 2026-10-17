import { STORED_ANSWERS } from '../../../packages/core/stored';

// Library answers kept on the phone (packages/core/stored.ts says which), in the page's IndexedDB,
// as the desktop's main process keeps them on disk (answerStore.ts): for the account signed in
// only, another account's and everything on sign-out removed, and nothing written by another
// version of the app shown, since its shape may have changed.
declare const __SQUIGGLY_VERSION__: string | undefined;
const VERSION = typeof __SQUIGGLY_VERSION__ === 'string' ? __SQUIGGLY_VERSION__ : 'dev';
const NAME = 'squiggly-library';
interface Entry { key: string; version: string; value: unknown; at: number }

function request<T>(asked: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { asked.onsuccess = () => resolve(asked.result); asked.onerror = () => reject(asked.error); });
}
function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error); });
}

export function createAnswers() {
  let opened: Promise<IDBDatabase | null> | null = null;
  // The account answers are kept for now, and the one the database holds (read when it opens).
  let account: string | null = null;
  let binding: Promise<void> = Promise.resolve();
  let writes = 0;
  const database = () => opened ??= new Promise<IDBDatabase | null>(resolve => {
    try {
      const asked = indexedDB.open(NAME, 1);
      asked.onupgradeneeded = () => {
        asked.result.createObjectStore('answers', { keyPath: 'key' }).createIndex('at', 'at');
        asked.result.createObjectStore('meta');
      };
      asked.onsuccess = () => resolve(asked.result);
      // Without IndexedDB, nothing is kept and every page asks the server, as before.
      asked.onerror = asked.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  async function wipe(db: IDBDatabase, owner: string | null) {
    const transaction = db.transaction(['answers', 'meta'], 'readwrite');
    transaction.objectStore('answers').clear();
    transaction.objectStore('meta').put(owner, 'account');
    await done(transaction);
  }
  // Past STORED_ANSWERS, the least recently written go: a page shown is read again, and written.
  async function trim(db: IDBDatabase) {
    const transaction = db.transaction('answers', 'readwrite');
    const answers = transaction.objectStore('answers');
    let extra = await request(answers.count()) - STORED_ANSWERS;
    if (extra > 0) {
      const cursors = answers.index('at').openCursor();
      cursors.onsuccess = () => {
        const cursor = cursors.result;
        if (!cursor || extra-- <= 0) return;
        cursor.delete(); cursor.continue();
      };
    }
    await done(transaction);
  }
  return {
    // Answers are kept for this account from now on; another account's are removed.
    bind(next: string) {
      account = next;
      binding = binding.then(async () => {
        const db = await database();
        if (!db || account !== next) return;
        const owner = await request(db.transaction('meta').objectStore('meta').get('account')).catch(() => null);
        if (owner !== next) await wipe(db, next);
      }).catch(() => undefined);
    },
    clear() {
      account = null;
      binding = binding.then(async () => { const db = await database(); if (db) await wipe(db, null); }).catch(() => undefined);
      return binding;
    },
    async read(key: string): Promise<unknown> {
      const mine = account;
      await binding;
      const db = mine && await database();
      if (!db || account !== mine) return undefined;
      try {
        const entry = await request(db.transaction('answers').objectStore('answers').get(key)) as Entry | undefined;
        // Shown again, it's asked for again too, and the fresh answer's write marks it recent.
        return entry && entry.version === VERSION && account === mine ? entry.value : undefined;
      } catch { return undefined; }
    },
    async write(key: string, value: unknown) {
      const mine = account;
      await binding;
      const db = mine && await database();
      if (!db || account !== mine) return;
      try {
        const transaction = db.transaction('answers', 'readwrite');
        transaction.objectStore('answers').put({ key, version: VERSION, value, at: Date.now() } satisfies Entry);
        await done(transaction);
        if (++writes % 100 === 0) await trim(db);
      } catch { /* Not kept; the page asks the server next time. */ }
    },
  };
}
