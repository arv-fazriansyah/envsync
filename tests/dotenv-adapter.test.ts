import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotenvAdapter } from '../src/adapters/dotenv.js';
import { AdapterType, SecretFormat, type SecretsFile } from '../src/core/index.js';
import type { DotenvAdapterConfig } from '../src/core/config.js';

let dir: string;

function config(overrides: Partial<DotenvAdapterConfig> = {}): DotenvAdapterConfig {
  return {
    type: AdapterType.DOTENV,
    name: 'local',
    enabled: true,
    path: join(dir, '.env'),
    format: SecretFormat.DOTENV,
    backup: true,
    mode: 0o600,
    include: ['*'],
    exclude: [],
    transform: { prefix: '', suffix: '', uppercase: false, lowercase: false },
    ...overrides,
  };
}

function secretsFile(entries: Array<{ key: string; value: string }>): SecretsFile {
  return {
    format: SecretFormat.DOTENV,
    path: 'test',
    entries: entries.map((e) => ({ ...e, isSecret: true })),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envsync-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DotenvAdapter.read', () => {
  it('returns an empty set when the file does not exist', async () => {
    const adapter = new DotenvAdapter(config());
    await adapter.initialize(config());

    const result = await adapter.read();

    expect(result.success).toBe(true);
    expect(result.data?.entries).toEqual([]);
  });

  it('reads and parses an existing .env file', async () => {
    const cfg = config();
    await writeFile(cfg.path, 'A=1\nB="two words"\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    const result = await adapter.read();

    expect(result.data?.entries.map((e) => `${e.key}=${e.value}`)).toEqual(['A=1', 'B=two words']);
    expect(result.data?.metadata?.checksum).toBeTruthy();
  });

  it('applies transform and filters while reading', async () => {
    const cfg = config({
      include: ['APP_*'],
      transform: { prefix: 'SVC_', suffix: '', uppercase: true, lowercase: false },
    });
    await writeFile(cfg.path, 'APP_KEY=1\nOTHER=2\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    const result = await adapter.read();

    expect(result.data?.entries.map((e) => e.key)).toEqual(['SVC_APP_KEY']);
  });

  it('fails when it was not initialized', async () => {
    const adapter = new DotenvAdapter(config());

    const result = await adapter.read();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not initialized/);
  });
});

describe('DotenvAdapter.write', () => {
  it('creates the file and its parent directory', async () => {
    const cfg = config({ path: join(dir, 'nested', 'deeper', '.env') });
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    const result = await adapter.write(secretsFile([{ key: 'A', value: '1' }, { key: 'B', value: 'two words' }]));

    expect(result.success).toBe(true);
    expect(await readFile(cfg.path, 'utf-8')).toBe('A=1\nB="two words"\n');
  });

  it('backs up the previous content before overwriting', async () => {
    const cfg = config();
    await writeFile(cfg.path, 'OLD=1\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    await adapter.write(secretsFile([{ key: 'NEW', value: '2' }]));

    const files = await readdir(dir);
    const backup = files.find((f) => f.startsWith('.env.backup.'));
    expect(backup).toBeDefined();
    expect(await readFile(join(dir, backup!), 'utf-8')).toBe('OLD=1\n');
  });

  it('does not create a backup when backup is disabled', async () => {
    const cfg = config({ backup: false });
    await writeFile(cfg.path, 'OLD=1\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    await adapter.write(secretsFile([{ key: 'NEW', value: '2' }]));

    const files = await readdir(dir);
    expect(files.some((f) => f.includes('.backup.'))).toBe(false);
  });

  it('refuses to write invalid keys and leaves the file untouched', async () => {
    const cfg = config();
    await writeFile(cfg.path, 'OLD=1\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);
    await adapter.initialize(cfg);

    const result = await adapter.write(secretsFile([{ key: 'bad key', value: 'x' }]));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid key format/);
    expect(await readFile(cfg.path, 'utf-8')).toBe('OLD=1\n');
  });
});

describe('DotenvAdapter.testConnection', () => {
  it('succeeds with a warning when the file is missing', async () => {
    const adapter = new DotenvAdapter(config());

    const result = await adapter.testConnection();

    expect(result.success).toBe(true);
    expect(result.warnings?.[0]).toMatch(/does not exist/);
  });

  it('succeeds silently when the file exists', async () => {
    const cfg = config();
    await writeFile(cfg.path, 'A=1\n', 'utf-8');
    const adapter = new DotenvAdapter(cfg);

    const result = await adapter.testConnection();

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
