import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  issueLicense,
  parseLicense,
  serializeLicense,
  verifyLicense,
} from '../src/core/offline-license.js';
import type { OfflineLicense, OfflineLicensePayload } from '../src/core/offline-license.js';

const payload = (overrides: Partial<OfflineLicensePayload> = {}): OfflineLicensePayload => ({
  id: 'lic-001',
  email: 'buyer@example.com',
  plan: 'personal',
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  ...overrides,
});

describe('generateKeyPair', () => {
  it('produces a usable Ed25519 key pair', () => {
    const { publicKey, privateKey } = generateKeyPair();

    expect(publicKey).toContain('BEGIN PUBLIC KEY');
    expect(privateKey).toContain('BEGIN PRIVATE KEY');

    const license = issueLicense(privateKey, payload());
    const result = verifyLicense(publicKey, license);

    expect(result.valid).toBe(true);
  });

  it('generates a different key pair each call', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();

    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('issueLicense + verifyLicense', () => {
  it('round-trips a signed license', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const lic = issueLicense(privateKey, payload());

    expect(lic.version).toBe(1);
    expect(lic.payload.email).toBe('buyer@example.com');
    expect(typeof lic.signature).toBe('string');

    const result = verifyLicense(publicKey, lic);
    expect(result.valid).toBe(true);
    expect(result.payload?.id).toBe('lic-001');
  });

  it('rejects a license signed by a different key', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const lic = issueLicense(a.privateKey, payload());

    const result = verifyLicense(b.publicKey, lic);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it('rejects a tampered payload', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const lic = issueLicense(privateKey, payload());

    const tampered: OfflineLicense = {
      ...lic,
      payload: { ...lic.payload, plan: 'enterprise' },
    };

    const result = verifyLicense(publicKey, tampered);
    expect(result.valid).toBe(false);
  });

  it('rejects an expired license', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const lic = issueLicense(privateKey, payload({ expiresAt: '2025-01-01T00:00:00Z' }));

    const result = verifyLicense(publicKey, lic, new Date('2026-01-01T00:00:00Z'));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('accepts a license with no expiry', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const lic = issueLicense(privateKey, payload({ expiresAt: null }));

    const result = verifyLicense(publicKey, lic, new Date('2030-01-01T00:00:00Z'));
    expect(result.valid).toBe(true);
  });
});

describe('parseLicense / serializeLicense', () => {
  it('round-trips through JSON', () => {
    const { privateKey } = generateKeyPair();
    const lic = issueLicense(privateKey, payload());
    const raw = serializeLicense(lic);
    const parsed = parseLicense(raw);

    expect(parsed).toEqual(lic);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseLicense('{nope')).toThrow(/invalid json/i);
  });

  it('throws when required fields are missing', () => {
    expect(() => parseLicense(JSON.stringify({ foo: 'bar' }))).toThrow(/invalid license/i);
  });
});

describe('verifyLicense with malformed input', () => {
  it('returns invalid instead of throwing for a garbage signature', () => {
    const { publicKey } = generateKeyPair();
    const lic: OfflineLicense = {
      version: 1,
      payload: payload(),
      signature: '!!!not-base64!!!',
    };

    const result = verifyLicense(publicKey, lic);
    expect(result.valid).toBe(false);
  });
});
