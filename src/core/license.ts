import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  verifyLicense,
  resolvePublicKey,
  parseLicense as parseOfflineLicense,
  serializeLicense as serializeOfflineLicense,
  type OfflineLicense,
} from './offline-license.js';

const DEFAULT_API_BASE = 'https://api.lemonsqueezy.com/v1';
const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LicenseStatus = 'active' | 'inactive' | 'expired' | 'disabled' | 'unknown';

/**
 * Locally cached proof that this machine activated a license.
 * Never contains the private signing material - only the license key the
 * customer already owns plus LemonSqueezy's instance id.
 */
export interface LicenseCache {
  key: string;
  instanceId: string | null;
  instanceName: string | null;
  status: LicenseStatus;
  customerEmail?: string;
  productName?: string;
  variantName?: string;
  activatedAt: string;
  lastValidatedAt: string;
  expiresAt: string | null;
}

export interface LicenseState {
  licensed: boolean;
  reason?: string;
  cache?: LicenseCache;
  source?: 'env' | 'cache' | 'online' | 'offline';
}

export interface LicenseOptions {
  cachePath?: string;
  offlineCachePath?: string;
  graceDays?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  apiBaseUrl?: string;
  publicKey?: string;
}

interface ResolvedOptions {
  cachePath: string;
  offlineCachePath: string;
  graceDays: number;
  fetchImpl: typeof fetch;
  now: () => Date;
  apiBaseUrl: string;
  publicKey?: string;
}

interface ApiResponse {
  status: number;
  data: any;
}

function resolveOptions(options: LicenseOptions = {}): ResolvedOptions {
  return {
    cachePath: options.cachePath ?? resolveLicenseCachePath(process.env, process.platform),
    offlineCachePath: options.offlineCachePath ?? resolveOfflineLicensePath(process.env, process.platform),
    graceDays: options.graceDays ?? DEFAULT_GRACE_DAYS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now: options.now ?? (() => new Date()),
    apiBaseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE,
    publicKey: options.publicKey,
  };
}

function apiError(data: any, status: number): string {
  const message =
    data?.error ||
    data?.errors?.[0]?.detail ||
    data?.message ||
    `LemonSqueezy request failed with HTTP ${status}`;
  return String(message);
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>
): Promise<ApiResponse> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function toCache(
  payload: any,
  instanceId: string | null,
  instanceName: string | null,
  nowIso: string,
  previous?: LicenseCache | null
): LicenseCache {
  const license = payload?.license_key ?? {};

  return {
    key: String(license.key ?? previous?.key ?? ''),
    instanceId: payload?.instance?.id ?? instanceId ?? previous?.instanceId ?? null,
    instanceName: payload?.instance?.name ?? instanceName ?? previous?.instanceName ?? null,
    status: (license.status ?? previous?.status ?? 'unknown') as LicenseStatus,
    customerEmail: license.customer_email ?? previous?.customerEmail,
    productName: license.product_name ?? previous?.productName,
    variantName: license.variant_name ?? previous?.variantName,
    activatedAt: previous?.activatedAt ?? nowIso,
    lastValidatedAt: nowIso,
    expiresAt: license.expires_at ?? previous?.expiresAt ?? null,
  };
}

/**
 * Activate a license key on this machine.
 */
export async function activateLicense(
  key: string,
  instanceName: string,
  options: LicenseOptions = {}
): Promise<LicenseCache> {
  const opts = resolveOptions(options);
  const { status, data } = await postJson(opts.fetchImpl, `${opts.apiBaseUrl}/licenses/activate`, {
    license_key: key,
    instance_name: instanceName,
  });

  if (status >= 400 || !data?.activated) {
    throw new Error(apiError(data, status));
  }

  const cache = toCache(data, null, instanceName, opts.now().toISOString());
  await writeLicenseCache(cache, opts);
  return cache;
}

/**
 * Revalidate an existing activation with LemonSqueezy.
 */
export async function validateLicense(
  key: string,
  instanceId: string,
  options: LicenseOptions = {}
): Promise<LicenseCache> {
  const opts = resolveOptions(options);
  const nowIso = opts.now().toISOString();
  const previous = await readLicenseCache(opts);

  const { status, data } = await postJson(opts.fetchImpl, `${opts.apiBaseUrl}/licenses/validate`, {
    license_key: key,
    instance_id: instanceId,
  });

  if (status >= 400) {
    throw new Error(apiError(data, status));
  }

  if (!data?.valid) {
    const cache: LicenseCache = {
      key,
      instanceId,
      instanceName: previous?.instanceName ?? null,
      status: 'inactive',
      customerEmail: previous?.customerEmail,
      productName: previous?.productName,
      variantName: previous?.variantName,
      activatedAt: previous?.activatedAt ?? nowIso,
      lastValidatedAt: nowIso,
      expiresAt: previous?.expiresAt ?? null,
    };
    await writeLicenseCache(cache, opts);
    return cache;
  }

  const cache = toCache(data, instanceId, previous?.instanceName ?? null, nowIso, previous);
  await writeLicenseCache(cache, opts);
  return cache;
}

/**
 * Deactivate this machine and remove the local cache.
 */
export async function deactivateLicense(
  key: string,
  instanceId: string,
  options: LicenseOptions = {}
): Promise<void> {
  const opts = resolveOptions(options);
  const { status, data } = await postJson(opts.fetchImpl, `${opts.apiBaseUrl}/licenses/deactivate`, {
    license_key: key,
    instance_id: instanceId,
  });

  if (status >= 400 || !data?.deactivated) {
    throw new Error(apiError(data, status));
  }

  await clearLicenseCache(opts);
}

/**
 * Read the cached license, if any.
 */
export async function readLicenseCache(options: LicenseOptions = {}): Promise<LicenseCache | null> {
  const { cachePath } = resolveOptions(options);

  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.key !== 'string' || typeof parsed.status !== 'string') {
      return null;
    }
    return parsed as LicenseCache;
  } catch {
    return null;
  }
}

/**
 * Persist the license cache (0600 where the platform supports it).
 */
export async function writeLicenseCache(
  cache: LicenseCache,
  options: LicenseOptions = {}
): Promise<void> {
  const { cachePath } = resolveOptions(options);

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Remove the local license cache.
 */
export async function clearLicenseCache(options: LicenseOptions = {}): Promise<void> {
  const { cachePath } = resolveOptions(options);
  await rm(cachePath, { force: true });
}

/**
 * Read the cached offline signed license, if any.
 */
export async function readOfflineLicense(options: LicenseOptions = {}): Promise<OfflineLicense | null> {
  const { offlineCachePath } = resolveOptions(options);

  try {
    const raw = await readFile(offlineCachePath, 'utf-8');
    return parseOfflineLicense(raw);
  } catch {
    return null;
  }
}

/**
 * Persist an offline signed license.
 */
export async function writeOfflineLicense(license: OfflineLicense, options: LicenseOptions = {}): Promise<void> {
  const { offlineCachePath } = resolveOptions(options);

  await mkdir(dirname(offlineCachePath), { recursive: true });
  await writeFile(offlineCachePath, serializeOfflineLicense(license), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Remove the cached offline license.
 */
export async function clearOfflineLicense(options: LicenseOptions = {}): Promise<void> {
  const { offlineCachePath } = resolveOptions(options);
  await rm(offlineCachePath, { force: true });
}

/**
 * Decide whether this machine may use paid features.
 *
 * A fresh cache is trusted for `graceDays` so CI keeps working when
 * LemonSqueezy or the network is unavailable.
 */
export async function getLicenseState(options: LicenseOptions = {}): Promise<LicenseState> {
  const opts = resolveOptions(options);
  const nowDate = opts.now();

  // Offline signed license takes precedence (air-gapped / issued after payment).
  const offline = await readOfflineLicense(opts);
  if (offline) {
    const result = verifyLicense(resolvePublicKey(opts.publicKey), offline, nowDate);
    if (result.valid && result.payload) {
      const cache: LicenseCache = {
        key: result.payload.id,
        instanceId: null,
        instanceName: null,
        status: 'active',
        customerEmail: result.payload.email,
        productName: 'envsync',
        variantName: result.payload.plan,
        activatedAt: result.payload.issuedAt,
        lastValidatedAt: nowDate.toISOString(),
        expiresAt: result.payload.expiresAt,
      };
      return { licensed: true, cache, source: 'offline' };
    }
  }

  const envKey = process.env['ENVSYNC_LICENSE_KEY'];
  const cached = await readLicenseCache(opts);

  let cache = cached;
  let source: 'env' | 'cache' = cached ? 'cache' : 'env';

  if (envKey) {
    source = 'env';
    cache = cached && cached.key === envKey ? cached : cached ? { ...cached, key: envKey } : null;
  }

  if (!cache) {
    if (!envKey) {
      return {
        licensed: false,
        reason: 'No license found. Run `envsync license activate <key>` to activate one.',
      };
    }

    const instanceId =
      process.env['ENVSYNC_LICENSE_INSTANCE_ID'] ?? 'envsync-cli';

    try {
      const validated = await validateLicense(envKey, instanceId, opts);
      const state = evaluate(validated, nowDate);
      return { ...state, source: 'env' };
    } catch (error) {
      return {
        licensed: false,
        reason: `License validation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        source: 'env',
      };
    }
  }

  const evaluated = evaluate(cache, nowDate);
  if (!evaluated.licensed) {
    return { ...evaluated, cache, source };
  }

  const lastValidated = new Date(cache.lastValidatedAt).getTime();
  const age = nowDate.getTime() - lastValidated;
  const withinGrace = Number.isFinite(lastValidated) && age <= opts.graceDays * DAY_MS;

  if (withinGrace) {
    return { licensed: true, cache, source };
  }

  if (!cache.instanceId) {
    return {
      licensed: false,
      reason: 'License cache has no instance id. Run `envsync license activate <key>` again.',
      cache,
      source,
    };
  }

  try {
    const validated = await validateLicense(cache.key, cache.instanceId, opts);
    const state = evaluate(validated, nowDate);
    return { ...state, cache: validated, source: 'online' };
  } catch (error) {
    return {
      licensed: false,
      reason: `License is offline and the ${opts.graceDays}-day grace period is over: ${
        error instanceof Error ? error.message : 'network unavailable'
      }`,
      cache,
      source,
    };
  }
}

function evaluate(cache: LicenseCache, now: Date): { licensed: boolean; reason?: string } {
  if (cache.status !== 'active') {
    return {
      licensed: false,
      reason: `License is ${cache.status}. Visit your LemonSqueezy receipt to reactivate it.`,
    };
  }

  if (cache.expiresAt) {
    const expiresAt = new Date(cache.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      return { licensed: false, reason: 'License has expired. Renew it to keep using paid features.' };
    }
  }

  return { licensed: true };
}

/**
 * Show only enough of a key to identify it in logs.
 */
export function maskLicenseKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}-…-${key.slice(-4)}`;
}

/**
 * Where the license cache lives, per platform.
 */
export function resolveLicenseCachePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const base = env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'envsync', 'license.json');
  }

  const base = env['XDG_CONFIG_HOME'] || join(env['HOME'] || homedir(), '.config');
  return join(base, 'envsync', 'license.json');
}

/**
 * Where the offline signed license lives, per platform.
 */
export function resolveOfflineLicensePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const base = env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'envsync', 'license.offline.json');
  }

  const base = env['XDG_CONFIG_HOME'] || join(env['HOME'] || homedir(), '.config');
  return join(base, 'envsync', 'license.offline.json');
}
