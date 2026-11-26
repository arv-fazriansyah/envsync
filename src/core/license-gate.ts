import type { Config } from './config.js';

/**
 * Adapter types that work without a paid license.
 * Everything else (cloud secret managers) requires an active license.
 */
export const FREE_ADAPTER_TYPES = ['dotenv'] as const;

export interface LicenseRequirement {
  required: boolean;
  /** Names of enabled adapters that need a license. */
  adapters: string[];
}

export interface LicenseScope {
  /** Only consider these adapter names (e.g. the ones used by one sync). */
  adapters?: Iterable<string>;
}

/**
 * Decide whether a config uses any paid (cloud) adapter.
 * Pure function: no network, no filesystem, safe to unit test.
 */
export function requiresLicense(config: Config, scope: LicenseScope = {}): LicenseRequirement {
  const free = new Set<string>(FREE_ADAPTER_TYPES);
  const only = scope.adapters ? new Set(scope.adapters) : null;
  const adapters: string[] = [];

  for (const [name, adapter] of Object.entries(config?.adapters ?? {})) {
    if (!adapter || adapter.enabled === false) continue;
    if (only && !only.has(name)) continue;

    const type = String((adapter as { type?: string }).type ?? '');
    if (!free.has(type)) {
      adapters.push(name);
    }
  }

  return { required: adapters.length > 0, adapters };
}

/**
 * Adapter names touched by the given sync operations.
 * Returns every adapter when `syncNames` is omitted (all syncs).
 */
export function adaptersUsedBySyncs(config: Config, syncNames?: Iterable<string>): string[] {
  const syncs = config?.sync ?? {};
  const selected = syncNames ? new Set(syncNames) : null;
  const names = new Set<string>();

  for (const [operation, sync] of Object.entries(syncs)) {
    if (!sync) continue;
    if (selected && !selected.has(operation)) continue;

    if (sync.source) names.add(sync.source);
    for (const destination of sync.destinations ?? []) {
      names.add(destination);
    }
  }

  return [...names];
}
