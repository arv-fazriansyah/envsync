import { Encrypter, Decrypter, generateIdentity, identityToRecipient, armor } from 'age-encryption';
import { randomBytes } from 'node:crypto';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedData {
  payload: string;  // armored string
  version: number;
  recipients: string[];
}

/**
 * Generate a new age key pair (X25519)
 */
export async function generateAgeKeyPair(): Promise<KeyPair> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { 
    publicKey: recipient, 
    privateKey: identity.toString() 
  };
}

/**
 * Encrypt plaintext for one or more recipients (public keys)
 * Returns age-armored encrypted data with metadata
 */
export async function encryptForRecipients(
  plaintext: string,
  recipientPublicKeys: string[]
): Promise<EncryptedData> {
  if (recipientPublicKeys.length === 0) {
    throw new Error('At least one recipient public key required');
  }

  const encrypter = new Encrypter();
  for (const key of recipientPublicKeys) {
    encrypter.addRecipient(key);
  }
  
  const ciphertext = await encrypter.encrypt(plaintext);
  const armored = armor.encode(ciphertext);
  
  return {
    payload: armored,
    version: 1,
    recipients: recipientPublicKeys,
  };
}

/**
 * Decrypt age-armored data using a private key
 */
export async function decryptWithPrivateKey(
  encryptedData: EncryptedData,
  privateKey: string
): Promise<string> {
  try {
    const decoded = armor.decode(encryptedData.payload);
    const decrypter = new Decrypter();
    decrypter.addIdentity(privateKey);
    const decrypted = await decrypter.decrypt(decoded, 'text');
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Invalid key or corrupted data'}`);
  }
}

/**
 * Decrypt raw ciphertext (Uint8Array) using a private key
 */
export async function decryptRawWithPrivateKey(
  ciphertext: Uint8Array,
  privateKey: string
): Promise<string> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(privateKey);
    const decrypted = await decrypter.decrypt(ciphertext, 'text');
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Invalid key or corrupted data'}`);
  }
}

/**
 * Generate a random passphrase for symmetric encryption fallback
 */
export function generatePassphrase(length = 32): string {
  return randomBytes(length).toString('base64url');
}

/**
 * Encrypt with a passphrase (scrypt + age symmetric)
 * Useful for local-only encryption without key pairs
 */
export async function encryptWithPassphrase(
  plaintext: string,
  passphrase: string
): Promise<EncryptedData> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  
  const ciphertext = await encrypter.encrypt(plaintext);
  const armored = armor.encode(ciphertext);
  
  return {
    payload: armored,
    version: 1,
    recipients: ['passphrase'],
  };
}

/**
 * Decrypt with a passphrase
 */
export async function decryptWithPassphrase(
  encryptedData: EncryptedData,
  passphrase: string
): Promise<string> {
  try {
    const decoded = armor.decode(encryptedData.payload);
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    const decrypted = await decrypter.decrypt(decoded, 'text');
    return decrypted;
  } catch (error) {
    throw new Error(`Passphrase decryption failed: ${error instanceof Error ? error.message : 'Invalid passphrase or corrupted data'}`);
  }
}

/**
 * Parse age public key from string (handles both raw and armored formats)
 */
export function parsePublicKey(key: string): string {
  const trimmed = key.trim();
  // If already age-armored public key (starts with age...)
  if (/^age1[0-9a-z]{58}$/.test(trimmed)) {
    return trimmed;
  }
  // If it's an armored block, extract the key
  const match = trimmed.match(/age1[0-9a-z]{58}/);
  if (match) return match[0];
  throw new Error('Invalid age public key format');
}

/**
 * Parse age private key from string
 */
export function parsePrivateKey(key: string): string {
  const trimmed = key.trim();
  // If already age-armored private key (starts with AGE-SECRET-KEY-...)
  if (/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(trimmed)) {
    return trimmed;
  }
  // If it's an armored block, extract
  const match = trimmed.match(/AGE-SECRET-KEY-1[0-9A-Z]{58}/);
  if (match) return match[0];
  throw new Error('Invalid age private key format');
}

/**
 * Validate that a string is a valid age public key
 */
export function isValidPublicKey(key: string): boolean {
  try {
    parsePublicKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is a valid age private key
 */
export function isValidPrivateKey(key: string): boolean {
  try {
    parsePrivateKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Armor binary ciphertext to PEM-like string
 */
export function armorCiphertext(ciphertext: Uint8Array): string {
  return armor.encode(ciphertext);
}

/**
 * Dearmor PEM-like string to binary ciphertext
 */
export function dearmorCiphertext(armored: string): Uint8Array {
  return armor.decode(armored);
}