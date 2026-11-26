import { describe, it, expect } from 'vitest';
import { SyncEngine, executeAllSyncs } from '../src/core/sync.js';
import { adapterRegistry, createCapabilities } from '../src/adapters/base.js';
import { SecretFormat, type SecretEntry, type SecretsFile } from '../src/core/secrets.js';
import type { Config } from '../src/core/config.js';

const entry = (key: string, value = 'v'): SecretEntry => ({ key, value, isSecret: true });

interface FakeOptions {
  readEntries?: SecretEntry[];
  connectionFails?: boolean;
  writeFails?: string;
}

function registerFake(type: string, options: FakeOptions = {}) {
  const writes: SecretsFile[] = [];

  adapterRegistry.register(type, (config) => ({
    type,
    name: config.name,
    capabilities: createCapabilities(),
    initialize: async () => ({ success: true }),
    testConnection: async () =>
      options.connectionFails
        ? { success: false, error: 'not authorized' }
        : { success: true },
    read: async () => ({
      success: true,
      data: {
        format: SecretFormat.DOTENV,
        path: `fake:${type}`,
        entries: options.readEntries ?? [],
      },
    }),
    write: async (secrets: SecretsFile) => {
      writes.push(secrets);
      return options.writeFails
        ? { success: false, error: options.writeFails }
        : { success: true };
    },
  }));

  return writes;
}

let counter = 0;
function uniqueType(): string {
  counter += 1;
  return `fake-${counter}`;
}

function makeConfig(
  adapters: Record<string, Record<string, unknown>>,
  sync: Record<string, Record<string, unknown>>
): Config {
  return { version: 1, adapters, sync } as unknown as Config;
}

function adapterConfig(type: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    name,
    enabled: true,
    include: ['*'],
    exclude: [],
    transform: { prefix: '', suffix: '', uppercase: false, lowercase: false },
    ...extra,
  };
}

describe('SyncEngine', () => {
  it('does not write anything in dry-run mode', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('A', '1'), entry('B', '2')] });
    const writes = registerFake(destType);

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'] } }
      )
    );

    const report = await engine.executeSync('push');

    expect(writes).toHaveLength(0);
    expect(report.summary.succeeded).toBe(1);
    expect(report.summary.totalSynced).toBe(0);
    expect(report.results[0]!.dryRun).toBe(true);
    expect(report.results[0]!.warnings).toContain('Dry run - no changes made');
    expect(report.results[0]!.diff?.added.map((e) => e.key)).toEqual(['A', 'B']);
  });

  it('writes all source entries when dry-run is disabled', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('A', '1'), entry('B', '2')] });
    const writes = registerFake(destType);

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    const report = await engine.executeSync('push');

    expect(writes).toHaveLength(1);
    expect(writes[0]!.entries.map((e) => `${e.key}=${e.value}`)).toEqual(['A=1', 'B=2']);
    expect(report.results[0]!.synced).toBe(2);
    expect(report.summary.totalSynced).toBe(2);
  });

  it('keeps the destination value for conflicts with dest-wins', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('SHARED', 'from-source')] });
    const writes = registerFake(destType, { readEntries: [entry('SHARED', 'from-dest')] });

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], conflict: 'dest-wins', dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    expect(writes[0]!.entries).toEqual([entry('SHARED', 'from-dest')]);
  });

  it('overwrites the destination value for conflicts with source-wins', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('SHARED', 'from-source')] });
    const writes = registerFake(destType, { readEntries: [entry('SHARED', 'from-dest')] });

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], conflict: 'source-wins', dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    expect(writes[0]!.entries).toEqual([entry('SHARED', 'from-source')]);
  });

  it('keeps destination-only entries for conflicts with merge', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, {
      readEntries: [entry('SOURCE_ONLY', 'new'), entry('SHARED', 'from-source')],
    });
    const writes = registerFake(destType, {
      readEntries: [entry('DEST_ONLY', 'keep-me'), entry('SHARED', 'from-dest')],
    });

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], conflict: 'merge', dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    const written = writes[0]!.entries.map((e) => `${e.key}=${e.value}`);
    expect(written).toContain('SOURCE_ONLY=new');
    expect(written).toContain('SHARED=from-source');
    expect(written).toContain('DEST_ONLY=keep-me');
  });

  it('applies the destination include/exclude filters', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, {
      readEntries: [entry('APP_OK', '1'), entry('APP_SECRET', '2'), entry('OTHER', '3')],
    });
    const writes = registerFake(destType);

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst', { include: ['APP_*'], exclude: ['*_SECRET'] }),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    expect(writes[0]!.entries.map((e) => e.key)).toEqual(['APP_OK']);
  });

  it('filters on source keys before applying the transform', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('APP_KEY', '1'), entry('OTHER', '2')] });
    const writes = registerFake(destType);

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst', {
            include: ['APP_*'],
            transform: { prefix: 'SVC_', suffix: '', uppercase: true, lowercase: false },
          }),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    expect(writes[0]!.entries.map((e) => e.key)).toEqual(['SVC_APP_KEY']);
  });

  it('applies the destination key transform', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('api_key', '1')] });
    const writes = registerFake(destType);

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst', {
            transform: { prefix: 'svc_', suffix: '_v2', uppercase: true, lowercase: false },
          }),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    await engine.executeSync('push');

    expect(writes[0]!.entries.map((e) => e.key)).toEqual(['SVC_API_KEY_V2']);
  });

  it('reports a destination connection failure without writing', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('A', '1')] });
    const writes = registerFake(destType, { connectionFails: true });

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    const report = await engine.executeSync('push');

    expect(writes).toHaveLength(0);
    expect(report.results[0]!.success).toBe(false);
    expect(report.results[0]!.errors[0]).toMatch(/connection failed.*not authorized/i);
    expect(report.summary.failed).toBe(1);
  });

  it('reports a write failure', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('A', '1')] });
    registerFake(destType, { writeFails: 'quota exceeded' });

    const engine = new SyncEngine(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        { push: { source: 'src', destinations: ['dst'], dryRun: false } }
      ),
      { dryRun: false }
    );

    const report = await engine.executeSync('push');

    expect(report.results[0]!.success).toBe(false);
    expect(report.results[0]!.errors[0]).toBe('quota exceeded');
  });

  it('throws when the source adapter is not configured', async () => {
    const engine = new SyncEngine(
      makeConfig({ dst: adapterConfig('dotenv', 'dst') }, {
        push: { source: 'missing', destinations: ['dst'] },
      })
    );

    await expect(engine.executeSync('push')).rejects.toThrow(/Source adapter config not found/);
  });

  it('throws when the sync operation does not exist', async () => {
    const engine = new SyncEngine(makeConfig({}, {}));

    await expect(engine.executeSync('nope')).rejects.toThrow(/Sync operation not found: nope/);
  });

  it('runs every configured sync operation', async () => {
    const sourceType = uniqueType();
    const destType = uniqueType();
    registerFake(sourceType, { readEntries: [entry('A', '1')] });
    registerFake(destType);

    const reports = await executeAllSyncs(
      makeConfig(
        {
          src: adapterConfig(sourceType, 'src'),
          dst: adapterConfig(destType, 'dst'),
        },
        {
          first: { source: 'src', destinations: ['dst'] },
          second: { source: 'src', destinations: ['dst'] },
        }
      )
    );

    expect(reports.map((r) => r.operation)).toEqual(['first', 'second']);
  });
});
