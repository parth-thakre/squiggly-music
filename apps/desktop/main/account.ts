import { Schema } from 'effect';
import type { Connection } from '../../../packages/core/contracts';
import { JsonStore } from './store';

// The saved sign-in, so the app reconnects at launch. The server address and username are kept
// as they are; the password only as the operating system encrypted it (DPAPI on Windows, the
// Keychain on macOS, the Secret Service keyring on Linux). Where the system has no real
// encryption to offer (Linux without a keyring falls back to a key built into Chromium), nothing
// is saved and the password stays in memory for the session. Disconnecting forgets it.
export interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}
const SavedSchema = Schema.NullOr(Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(2048)),
  username: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  // Base64 of the encrypted password.
  password: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16384)),
}));

export class Account {
  private store: JsonStore<typeof SavedSchema.Type, typeof SavedSchema.Encoded>;
  constructor(path: string, private encryption: Encryption, private platform: NodeJS.Platform = process.platform) {
    this.store = new JsonStore(path, SavedSchema, null);
  }
  load() { return this.store.load(); }

  get canRemember() {
    if (!this.encryption.isEncryptionAvailable()) return false;
    const backend = this.platform === 'linux' ? this.encryption.getSelectedStorageBackend?.() ?? 'unknown' : null;
    return backend !== 'basic_text' && backend !== 'unknown';
  }
  // The server and username of the saved sign-in, without the password.
  get saved() { const value = this.store.value; return value && { url: value.url, username: value.username }; }
  // The saved sign-in with its password, or null when there is none or it no longer decrypts
  // (another user account, or a reset keyring).
  connection(): Connection | null {
    const value = this.store.value;
    if (!value || !this.canRemember) return null;
    try { return { url: value.url, username: value.username, password: this.encryption.decryptString(Buffer.from(value.password, 'base64')) }; }
    catch { return null; }
  }
  async remember(connection: Connection) {
    if (!this.canRemember) { await this.forget(); return; }
    const password = this.encryption.encryptString(connection.password).toString('base64');
    await this.store.save({ url: connection.url, username: connection.username, password });
  }
  // Always writes, even when nothing is saved yet: the store's value only changes once a write
  // finishes, so a first sign-in still being written would otherwise land after this.
  async forget() { await this.store.save(null); }
}
