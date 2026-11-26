import type { SecretEntry, SecretsFile, AdapterConfig, BaseAdapterConfig } from '../core/index.js';

/**
 * Transform configuration type
 */
export type TransformConfig = BaseAdapterConfig['transform'];

/**
 * Result of adapter operations
 */
export interface AdapterResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

/**
 * Capabilities an adapter may have
 */
export interface AdapterCapabilities {
  read: boolean;
  write: boolean;
  list: boolean;
  delete: boolean;
  supportsSecrets: boolean;
  supportsConfigMaps: boolean;
  requiresAuth: boolean;
}

/**
 * Base adapter interface
 * All adapters must implement this
 */
export interface Adapter {
  /** Unique adapter type identifier */
  readonly type: string;
  
  /** Human-readable name */
  readonly name: string;
  
  /** Adapter capabilities */
  readonly capabilities: AdapterCapabilities;
  
  /** Initialize adapter with config */
  initialize(config: AdapterConfig): Promise<AdapterResult>;
  
  /** Test connection/authentication */
  testConnection(): Promise<AdapterResult>;
  
  /** Read secrets from source */
  read(): Promise<AdapterResult<SecretsFile>>;
  
  /** Write secrets to destination */
  write(secrets: SecretsFile): Promise<AdapterResult>;
  
  /** List available environments/contexts */
  listEnvironments?(): Promise<AdapterResult<string[]>>;
  
  /** Delete secrets (if supported) */
  delete?(keys: string[]): Promise<AdapterResult>;
  
  /** Get adapter-specific metadata */
  getMetadata?(): Promise<AdapterResult<Record<string, unknown>>>;
  
  /** Cleanup resources */
  dispose?(): Promise<void>;
}

/**
 * Adapter factory function type - accepts the discriminated union config
 */
export type AdapterFactory = (config: AdapterConfig) => Adapter;

/**
 * Registry of available adapters
 */
export class AdapterRegistry {
  private factories = new Map<string, AdapterFactory>();
  private instances = new Map<string, Adapter>();
  
  register(type: string, factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }
  
  create(type: string, config: AdapterConfig): Adapter {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Adapter not found: ${type}`);
    }
    const instance = factory(config);
    this.instances.set(`${type}:${config.name}`, instance);
    return instance;
  }
  
  get(type: string, name: string): Adapter | undefined {
    return this.instances.get(`${type}:${name}`);
  }
  
  getAll(): Adapter[] {
    return Array.from(this.instances.values());
  }
  
  async disposeAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      if (instance.dispose) {
        await instance.dispose();
      }
    }
    this.instances.clear();
  }
  
  getRegisteredTypes(): string[] {
    return Array.from(this.factories.keys());
  }
}

/**
 * Global adapter registry instance
 */
export const adapterRegistry = new AdapterRegistry();

/**
 * Helper to create standard capabilities
 */
export function createCapabilities(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return {
    read: true,
    write: true,
    list: false,
    delete: false,
    supportsSecrets: true,
    supportsConfigMaps: false,
    requiresAuth: false,
    ...overrides,
  };
}

/**
 * Apply key transformations per config
 */
export function transformKeys(
  entries: SecretEntry[],
  transform: TransformConfig
): SecretEntry[] {
  return entries.map(entry => {
    let key = entry.key;
    
    if (transform.prefix) key = transform.prefix + key;
    if (transform.suffix) key = key + transform.suffix;
    if (transform.uppercase) key = key.toUpperCase();
    if (transform.lowercase) key = key.toLowerCase();
    
    return { ...entry, key };
  });
}

/**
 * Filter entries by include/exclude patterns
 */
export function filterEntries(
  entries: SecretEntry[],
  include: string[],
  exclude: string[]
): SecretEntry[] {
  let filtered = entries;
  
  if (include.length > 0 && !include.includes('*')) {
    filtered = filtered.filter(entry => 
      include.some(pattern => matchPattern(entry.key, pattern))
    );
  }
  
  if (exclude.length > 0) {
    filtered = filtered.filter(entry => 
      !exclude.some(pattern => matchPattern(entry.key, pattern))
    );
  }
  
  return filtered;
}

function matchPattern(key: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(key);
}

/**
 * Validate entries before write
 */
export function validateEntries(entries: SecretEntry[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  
  for (const entry of entries) {
    if (!entry.key) {
      errors.push('Empty key found');
      continue;
    }
    
    if (seen.has(entry.key)) {
      errors.push(`Duplicate key: ${entry.key}`);
    }
    seen.add(entry.key);
    
    // Check for invalid characters in key
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)) {
      errors.push(`Invalid key format: ${entry.key} (must match ^[A-Za-z_][A-Za-z0-9_]*$)`);
    }
    
    // Warn on very large values
    if (entry.value.length > 32768) {
      errors.push(`Value too large for ${entry.key} (${entry.value.length} chars, max 32768)`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}