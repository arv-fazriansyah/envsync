import { describe, it, expect } from 'vitest';
import {
  generateAgeKeyPair,
  encryptForRecipients,
  decryptWithPrivateKey,
  encryptWithPassphrase,
  decryptWithPassphrase,
  generatePassphrase,
  parsePublicKey,
  parsePrivateKey,
  isValidPublicKey,
  isValidPrivateKey,
  armorCiphertext,
  dearmorCiphertext,
} from '../src/core/crypto.js';

describe('age key pairs', () => {
  it('generates an age1 public key and an AGE-SECRET-KEY private key', async () => {
    const keyPair = await generateAgeKeyPair();

    expect(keyPair.publicKey).toMatch(/^age1[0-9a-z]{58}$/);
    expect(keyPair.privateKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  });

  it('generates a different key pair every time', async () => {
    const first = await generateAgeKeyPair();
    const second = await generateAgeKeyPair();

    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.privateKey).not.toBe(second.privateKey);
  });
});

describe('encryptForRecipients / decryptWithPrivateKey', () => {
  it('round-trips a dotenv payload', async () => {
    const { publicKey, privateKey } = await generateAgeKeyPair();
    const plaintext = 'DATABASE_URL=postgres://localhost/app\nAPI_KEY=abc123\n';

    const encrypted = await encryptForRecipients(plaintext, [publicKey]);
    const decrypted = await decryptWithPrivateKey(encrypted, privateKey);

    expect(decrypted).toBe(plaintext);
  });

  it('produces armored output that does not contain the plaintext', async () => {
    const { publicKey } = await generateAgeKeyPair();

    const encrypted = await encryptForRecipients('API_KEY=super-secret', [publicKey]);

    expect(encrypted.payload).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    expect(encrypted.payload).not.toContain('super-secret');
    expect(encrypted.version).toBe(1);
    expect(encrypted.recipients).toEqual([publicKey]);
  });

  it('lets every listed recipient decrypt the same payload', async () => {
    const alice = await generateAgeKeyPair();
    const bob = await generateAgeKeyPair();
    const encrypted = await encryptForRecipients('SHARED=yes', [alice.publicKey, bob.publicKey]);

    expect(await decryptWithPrivateKey(encrypted, alice.privateKey)).toBe('SHARED=yes');
    expect(await decryptWithPrivateKey(encrypted, bob.privateKey)).toBe('SHARED=yes');
  });

  it('rejects a recipient that was not part of the encryption', async () => {
    const allowed = await generateAgeKeyPair();
    const outsider = await generateAgeKeyPair();
    const encrypted = await encryptForRecipients('SECRET=1', [allowed.publicKey]);

    await expect(decryptWithPrivateKey(encrypted, outsider.privateKey)).rejects.toThrow(
      /Decryption failed/
    );
  });

  it('refuses to encrypt without a recipient', async () => {
    await expect(encryptForRecipients('SECRET=1', [])).rejects.toThrow(
      /At least one recipient/
    );
  });
});

describe('passphrase encryption', () => {
  it('round-trips with the same passphrase', async () => {
    const encrypted = await encryptWithPassphrase('TOKEN=abc', 'correct horse battery staple');

    expect(await decryptWithPassphrase(encrypted, 'correct horse battery staple')).toBe('TOKEN=abc');
  });

  it('fails with the wrong passphrase', async () => {
    const encrypted = await encryptWithPassphrase('TOKEN=abc', 'right-passphrase');

    await expect(decryptWithPassphrase(encrypted, 'wrong-passphrase')).rejects.toThrow(
      /Passphrase decryption failed/
    );
  });

  it('generates url-safe passphrases of the requested byte length', () => {
    const passphrase = generatePassphrase(32);

    expect(passphrase).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(passphrase, 'base64url')).toHaveLength(32);
  });
});

describe('key parsing and validation', () => {
  it('accepts a bare public key', () => {
    const key = 'age1dkhktp34q35rzcpexrhg7p0z85uazdw0gyelfhejxhsmnle69urqj8gndc';

    expect(parsePublicKey(`  ${key}\n`)).toBe(key);
    expect(isValidPublicKey(key)).toBe(true);
  });

  it('extracts a public key out of surrounding text', () => {
    const key = 'age1dkhktp34q35rzcpexrhg7p0z85uazdw0gyelfhejxhsmnle69urqj8gndc';

    expect(parsePublicKey(`# created by age-keygen\n${key}\n`)).toBe(key);
  });

  it('rejects garbage public keys', () => {
    expect(() => parsePublicKey('not-a-key')).toThrow(/Invalid age public key/);
    expect(isValidPublicKey('ssh-ed25519 AAAA')).toBe(false);
    expect(isValidPublicKey('age1short')).toBe(false);
  });

  it('accepts a bare private key and rejects garbage', () => {
    const key = 'AGE-SECRET-KEY-16GDYQ8UNJWXH7MXXZYJCEA08E4K5WFGWSRCFMUMKQEY3A0CDGAPQSYG2HQ';

    expect(parsePrivateKey(`${key}\n`)).toBe(key);
    expect(isValidPrivateKey(key)).toBe(true);
    expect(isValidPrivateKey('AGE-SECRET-KEY-nope')).toBe(false);
  });
});

describe('armor helpers', () => {
  it('round-trips binary ciphertext', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);

    const armored = armorCiphertext(bytes);
    const restored = dearmorCiphertext(armored);

    expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });
});
