import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateLicense,
  validateLicense,
  deactivateLicense,
  readLicenseCache,
  writeLicenseCache,
  getLicenseState,
  maskLicenseKey,
  resolveLicenseCachePath,
  type LicenseCache,
} from '../src/core/license.js';

let dir: string;
let cachePath: string;

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function licenseKeyPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'active',
    key: 'ABCD-1234-EFGH-5678',
    activation_limit: 3,
    activation_usage: 1,
    created_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    customer_email: 'buyer@example.com',
    product_name: 'envsync',
    variant_name: 'Personal',
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return jsonResponse(body, status);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const freshCache = (overrides: Partial<LicenseCache> = {}): LicenseCache => ({
  key: 'ABCD-1234-EFGH-5678',
  instanceId: 'inst-1',
  instanceName: 'laptop',
  status: 'active',
  customerEmail: 'buyer@example.com',
  productName: 'envsync',
  variantName: 'Personal',
  activatedAt: '2026-01-01T00:00:00Z',
  lastValidatedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  ...overrides,
});

const now = () => new Date('2026-01-01T00:00:00Z');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envsync-license-'));
  cachePath = join(dir, 'license.json');
  delete process.env['ENVSYNC_LICENSE_KEY'];
});

afterEach(async () => {
  delete process.env['ENVSYNC_LICENSE_KEY'];
  await rm(dir, { recursive: true, force: true });
});

describe('activateLicense', () => {
  it('calls the LemonSqueezy activate endpoint and caches the license', async () => {
    const { calls, fetchImpl } = mockFetch({
      activated: true,
      error: null,
      license_key: licenseKeyPayload(),
      instance: { id: 'inst-1', name: 'laptop' },
    });

    const cache = await activateLicense('ABCD-1234-EFGH-5678', 'laptop', {
      cachePath,
      fetchImpl,
      now,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      license_key: 'ABCD-1234-EFGH-5678',
      instance_name: 'laptop',
    });
    expect(cache.status).toBe('active');
    expect(cache.instanceId).toBe('inst-1');
    expect(cache.activatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(cache.lastValidatedAt).toBe('2026-01-01T00:00:00.000Z');

    const stored = JSON.parse(await readFile(cachePath, 'utf-8'));
    expect(stored.key).toBe('ABCD-1234-EFGH-5678');
    expect(stored.instanceId).toBe('inst-1');
  });

  it('throws the API error message for an invalid key', async () => {
    const { fetchImpl } = mockFetch({ activated: false, error: 'license_key not found' }, 400);

    await expect(
      activateLicense('NOPE', 'laptop', { cachePath, fetchImpl, now })
    ).rejects.toThrow(/license_key not found/);
  });

  it('does not write a cache file when activation fails', async () => {
    const { fetchImpl } = mockFetch({ activated: false, error: 'activation limit reached' }, 400);

    await expect(activateLicense('NOPE', 'laptop', { cachePath, fetchImpl, now })).rejects.toThrow();

    expect(await readLicenseCache({ cachePath })).toBeNull();
  });
});

describe('validateLicense', () => {
  it('revalidates and refreshes lastValidatedAt', async () => {
    const { calls, fetchImpl } = mockFetch({
      valid: true,
      license_key: licenseKeyPayload(),
      instance: { id: 'inst-1', name: 'laptop' },
    });

    const cache = await validateLicense('ABCD-1234-EFGH-5678', 'inst-1', {
      cachePath,
      fetchImpl,
      now: () => new Date('2026-02-01T00:00:00Z'),
    });

    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/licenses/validate');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      license_key: 'ABCD-1234-EFGH-5678',
      instance_id: 'inst-1',
    });
    expect(cache.lastValidatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('marks the cache inactive when the API says the license is invalid', async () => {
    const { fetchImpl } = mockFetch({ valid: false, error: 'license_key is disabled' });

    const cache = await validateLicense('ABCD', 'inst-1', { cachePath, fetchImpl, now });

    expect(cache.status).toBe('inactive');
  });
});

describe('deactivateLicense', () => {
  it('calls the deactivate endpoint and removes the local cache', async () => {
    await writeLicenseCache(freshCache(), { cachePath });
    const { calls, fetchImpl } = mockFetch({ deactivated: true });

    await deactivateLicense('ABCD-1234-EFGH-5678', 'inst-1', { cachePath, fetchImpl });

    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/licenses/deactivate');
    expect(await readLicenseCache({ cachePath })).toBeNull();
  });
});

describe('getLicenseState', () => {
  it('reports no license when there is no cache and no env key', async () => {
    const state = await getLicenseState({ cachePath, now });

    expect(state.licensed).toBe(false);
    expect(state.reason).toMatch(/no license/i);
  });

  it('trusts a fresh cache without hitting the network', async () => {
    await writeLicenseCache(freshCache(), { cachePath });
    const { calls, fetchImpl } = mockFetch({});

    const state = await getLicenseState({ cachePath, now, fetchImpl });

    expect(state.licensed).toBe(true);
    expect(state.source).toBe('cache');
    expect(calls).toHaveLength(0);
  });

  it('revalidates online when the cache is older than the grace period', async () => {
    await writeLicenseCache(
      freshCache({ lastValidatedAt: '2025-12-01T00:00:00Z' }),
      { cachePath }
    );
    const { calls, fetchImpl } = mockFetch({
      valid: true,
      license_key: licenseKeyPayload(),
      instance: { id: 'inst-1', name: 'laptop' },
    });

    const state = await getLicenseState({ cachePath, now, graceDays: 7, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(state.licensed).toBe(true);
    expect(state.source).toBe('online');
    expect(state.cache?.lastValidatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stays licensed within the grace period even if the network is down', async () => {
    await writeLicenseCache(
      freshCache({ lastValidatedAt: '2025-12-29T00:00:00Z' }),
      { cachePath }
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const state = await getLicenseState({ cachePath, now, graceDays: 7, fetchImpl });

    expect(state.licensed).toBe(true);
    expect(state.source).toBe('cache');
  });

  it('reports an offline error when the grace period is over and the network fails', async () => {
    await writeLicenseCache(
      freshCache({ lastValidatedAt: '2025-12-01T00:00:00Z' }),
      { cachePath }
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const state = await getLicenseState({ cachePath, now, graceDays: 7, fetchImpl });

    expect(state.licensed).toBe(false);
    expect(state.reason).toMatch(/offline/i);
  });

  it('reports an expired license even when the cache is fresh', async () => {
    await writeLicenseCache(
      freshCache({ expiresAt: '2025-12-31T00:00:00Z' }),
      { cachePath }
    );

    const state = await getLicenseState({ cachePath, now });

    expect(state.licensed).toBe(false);
    expect(state.reason).toMatch(/expired/i);
  });

  it('reports a non-active license status', async () => {
    await writeLicenseCache(freshCache({ status: 'disabled' }), { cachePath });

    const state = await getLicenseState({ cachePath, now });

    expect(state.licensed).toBe(false);
    expect(state.reason).toMatch(/disabled/i);
  });

  it('uses ENVSYNC_LICENSE_KEY for headless CI when no cache exists', async () => {
    process.env['ENVSYNC_LICENSE_KEY'] = 'ENV-KEY-9999';
    const { calls, fetchImpl } = mockFetch({
      valid: true,
      license_key: licenseKeyPayload({ key: 'ENV-KEY-9999' }),
      instance: { id: 'ci-runner', name: 'ci' },
    });

    const state = await getLicenseState({ cachePath, now, fetchImpl });

    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/licenses/validate');
    expect(JSON.parse(calls[0]!.body!).license_key).toBe('ENV-KEY-9999');
    expect(state.licensed).toBe(true);
    expect(state.source).toBe('env');
  });
});

describe('maskLicenseKey', () => {
  it('keeps the first and last four characters only', () => {
    expect(maskLicenseKey('ABCD-1234-EFGH-5678')).toBe('ABCD-…-5678');
  });

  it('does not leak short keys', () => {
    expect(maskLicenseKey('SHORT')).toBe('••••');
  });
});

describe('resolveLicenseCachePath', () => {
  it('uses APPDATA on Windows', () => {
    const path = resolveLicenseCachePath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32');

    expect(path).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'envsync', 'license.json'));
  });

  it('uses XDG_CONFIG_HOME on Linux when set', () => {
    const path = resolveLicenseCachePath({ XDG_CONFIG_HOME: '/home/me/.config' }, 'linux');

    expect(path).toBe(join('/home/me/.config', 'envsync', 'license.json'));
  });

  it('falls back to ~/.config on Linux', () => {
    const path = resolveLicenseCachePath({ HOME: '/home/me' }, 'linux');

    expect(path).toBe(join('/home/me', '.config', 'envsync', 'license.json'));
  });
});
