import { describe, it, expect } from 'vitest';
import {
  createCapabilities,
  transformKeys,
  filterEntries,
  validateEntries,
  AdapterRegistry,
} from '../src/adapters/base.js';
import type { SecretEntry } from '../src/core/secrets.js';

const entry = (key: string, value = 'v'): SecretEntry => ({ key, value, isSecret: true });
const transform = (overrides: Partial<Parameters<typeof transformKeys>[1]> = {}) => ({
  prefix: '',
  suffix: '',
  uppercase: false,
  lowercase: false,
  ...overrides,
});

describe('createCapabilities', () => {
  it('defaults to read/write secrets without auth', () => {
    expect(createCapabilities()).toEqual({
      read: true,
      write: true,
      list: false,
      delete: false,
      supportsSecrets: true,
      supportsConfigMaps: false,
      requiresAuth: false,
    });
  });

  it('applies overrides', () => {
    const caps = createCapabilities({ write: false, requiresAuth: true });

    expect(caps.write).toBe(false);
    expect(caps.requiresAuth).toBe(true);
    expect(caps.read).toBe(true);
  });
});

describe('transformKeys', () => {
  it('leaves keys alone with an empty transform', () => {
    expect(transformKeys([entry('api_key')], transform())).toEqual([entry('api_key')]);
  });

  it('applies prefix, suffix and case in that order', () => {
    const result = transformKeys(
      [entry('api_key')],
      transform({ prefix: 'app_', suffix: '_v2', uppercase: true })
    );

    expect(result[0]!.key).toBe('APP_API_KEY_V2');
  });

  it('does not mutate the input entries', () => {
    const original = [entry('api_key')];

    transformKeys(original, transform({ uppercase: true }));

    expect(original[0]!.key).toBe('api_key');
  });
});

describe('filterEntries', () => {
  const entries = [entry('DB_HOST'), entry('DB_PORT'), entry('API_KEY'), entry('DEBUG')];

  it('keeps everything when include is a wildcard', () => {
    expect(filterEntries(entries, ['*'], [])).toHaveLength(4);
  });

  it('keeps everything when include is empty', () => {
    expect(filterEntries(entries, [], [])).toHaveLength(4);
  });

  it('applies include globs', () => {
    expect(filterEntries(entries, ['DB_*'], []).map((e) => e.key)).toEqual(['DB_HOST', 'DB_PORT']);
  });

  it('applies exclude after include', () => {
    expect(filterEntries(entries, ['DB_*'], ['*_PORT']).map((e) => e.key)).toEqual(['DB_HOST']);
  });

  it('supports ? as a single character wildcard', () => {
    expect(filterEntries(entries, ['DB_HOS?'], []).map((e) => e.key)).toEqual(['DB_HOST']);
  });
});

describe('validateEntries', () => {
  it('accepts well-formed unique keys', () => {
    expect(validateEntries([entry('DB_HOST'), entry('_PRIVATE'), entry('A1')])).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects duplicate keys', () => {
    const result = validateEntries([entry('A'), entry('A')]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate key: A');
  });

  it('rejects keys that are not shell-safe', () => {
    const result = validateEntries([entry('1BAD'), entry('has-dash'), entry('has space')]);

    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.startsWith('Invalid key format'))).toHaveLength(3);
  });

  it('rejects values larger than 32 KiB', () => {
    const result = validateEntries([entry('BIG', 'x'.repeat(32769))]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/too large/);
  });

  it('rejects an empty key', () => {
    const result = validateEntries([{ key: '', value: 'v', isSecret: true }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Empty key found');
  });
});

describe('AdapterRegistry', () => {
  it('creates, stores and looks up adapters by type and name', () => {
    const registry = new AdapterRegistry();
    const created: string[] = [];

    registry.register('fake', (config) => {
      created.push(config.name);
      return {
        type: 'fake',
        name: config.name,
        capabilities: createCapabilities(),
        initialize: async () => ({ success: true }),
        testConnection: async () => ({ success: true }),
        read: async () => ({ success: true }),
        write: async () => ({ success: true }),
      };
    });

    const adapter = registry.create('fake', { type: 'fake', name: 'one' } as never);

    expect(created).toEqual(['one']);
    expect(adapter.name).toBe('one');
    expect(registry.get('fake', 'one')).toBe(adapter);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getRegisteredTypes()).toEqual(['fake']);
  });

  it('throws for an unknown adapter type', () => {
    const registry = new AdapterRegistry();

    expect(() => registry.create('nope', { type: 'nope', name: 'x' } as never)).toThrow(
      /Adapter not found: nope/
    );
  });

  it('disposes all created adapters and clears the cache', async () => {
    const registry = new AdapterRegistry();
    let disposed = 0;

    registry.register('fake', (config) => ({
      type: 'fake',
      name: config.name,
      capabilities: createCapabilities(),
      initialize: async () => ({ success: true }),
      testConnection: async () => ({ success: true }),
      read: async () => ({ success: true }),
      write: async () => ({ success: true }),
      dispose: async () => {
        disposed += 1;
      },
    }));

    registry.create('fake', { type: 'fake', name: 'one' } as never);
    registry.create('fake', { type: 'fake', name: 'two' } as never);
    await registry.disposeAll();

    expect(disposed).toBe(2);
    expect(registry.getAll()).toEqual([]);
  });
});
