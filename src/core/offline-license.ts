import { sign, verify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const OFFLINE_LICENSE_VERSION = 1 as const;

/**
 * Default seller public key embedded in the shipped CLI.
 * Sellers should replace this with their own key (via ENVSYNC_LICENSE_PUBLIC_KEY
 * or by rebuilding with their own key) before publishing.
 */
export const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8JFOvd4heKvpgohFxjZE/6zL37SgliqvghDi3vbbBG0=
-----END PUBLIC KEY-----`;

/**
 * Resolve the seller public key used to verify offline licenses.
 * Order: explicit arg -> ENVSYNC_LICENSE_PUBLIC_KEY -> ENVSYNC_LICENSE_PUBLIC_KEY_FILE -> default.
 */
export function resolvePublicKey(explicit?: string): string {
  if (explicit) return explicit;

  const envValue = process.env['ENVSYNC_LICENSE_PUBLIC_KEY'];
  if (envValue) {
    if (envValue.includes('BEGIN PUBLIC KEY')) return envValue;
    try {
      return Buffer.from(envValue, 'base64').toString('utf8');
    } catch {
      return envValue;
    }
  }

  const envFile = process.env['ENVSYNC_LICENSE_PUBLIC_KEY_FILE'];
  if (envFile) {
    try {
      return readFileSync(envFile, 'utf8');
    } catch {
      // fall through to default
    }
  }

  return DEFAULT_PUBLIC_KEY;
}

export interface OfflineLicensePayload {
  id: string;
  email: string;
  plan: string;
  issuedAt: string;
  expiresAt: string | null;
}

export interface OfflineLicense {
  version: typeof OFFLINE_LICENSE_VERSION;
  payload: OfflineLicensePayload;
  signature: string;
}

export interface OfflineKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  payload?: OfflineLicensePayload;
}

/**
 * Generate a fresh Ed25519 key pair (PEM-encoded).
 * The private key stays with the seller; the public key is embedded in the
 * shipped CLI so buyers can verify licenses offline.
 */
export function generateKeyPair(): OfflineKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { publicKey, privateKey };
}

function canonicalPayload(payload: OfflineLicensePayload): string {
  // Stable, sorted-key JSON so signing and verification agree byte-for-byte.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    ordered[key] = (payload as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Sign a payload with the seller's private key.
 */
export function issueLicense(privateKeyPem: string, payload: OfflineLicensePayload): OfflineLicense {
  const signature = sign(null, Buffer.from(canonicalPayload(payload), 'utf8'), privateKeyPem).toString('base64');

  return {
    version: OFFLINE_LICENSE_VERSION,
    payload: { ...payload },
    signature,
  };
}

export function serializeLicense(license: OfflineLicense): string {
  return JSON.stringify(license, null, 2) + '\n';
}

export function parseLicense(raw: string): OfflineLicense {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON license file');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid license file');
  }

  const candidate = parsed as Partial<OfflineLicense>;
  if (candidate.version !== OFFLINE_LICENSE_VERSION) {
    throw new Error('Invalid license file: unsupported version');
  }
  if (!candidate.payload || typeof candidate.payload !== 'object') {
    throw new Error('Invalid license file: missing payload');
  }
  if (typeof candidate.signature !== 'string' || candidate.signature.length === 0) {
    throw new Error('Invalid license file: missing signature');
  }

  const payload = candidate.payload as Partial<OfflineLicensePayload>;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.plan !== 'string' ||
    typeof payload.issuedAt !== 'string' ||
    !(payload.expiresAt === null || typeof payload.expiresAt === 'string')
  ) {
    throw new Error('Invalid license file: malformed payload');
  }

  return {
    version: OFFLINE_LICENSE_VERSION,
    payload: payload as OfflineLicensePayload,
    signature: candidate.signature,
  };
}

/**
 * Verify a signed license against the seller's public key.
 */
export function verifyLicense(
  publicKeyPem: string,
  license: OfflineLicense,
  now: Date = new Date()
): VerifyResult {
  if (!license || license.version !== OFFLINE_LICENSE_VERSION) {
    return { valid: false, reason: 'Invalid license version' };
  }

  let signatureBuffer: Buffer;
  try {
    signatureBuffer = Buffer.from(license.signature, 'base64');
  } catch {
    return { valid: false, reason: 'Invalid signature encoding' };
  }

  if (signatureBuffer.length === 0) {
    return { valid: false, reason: 'Invalid signature' };
  }

  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonicalPayload(license.payload), 'utf8'), publicKeyPem, signatureBuffer);
  } catch {
    ok = false;
  }

  if (!ok) {
    return { valid: false, reason: 'License signature is invalid' };
  }

  if (license.payload.expiresAt) {
    const expiresAt = new Date(license.payload.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      return { valid: false, reason: 'License has expired' };
    }
  }

  return { valid: true, payload: license.payload };
}

/**
 * Convenience: build a payload with a fresh id and issuedAt.
 */
export function buildPayload(input: {
  email: string;
  plan: string;
  expiresAt?: string | null;
  issuedAt?: string;
  id?: string;
}): OfflineLicensePayload {
  return {
    id: input.id ?? randomUUID(),
    email: input.email,
    plan: input.plan,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
  };
}
