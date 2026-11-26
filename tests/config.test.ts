import { describe, it, expect } from 'vitest';
import {
  AdapterType,
  parseConfig,
  ConfigSchema,
  AdapterConfigSchema,
  SyncConfigSchema,
  defaultConfig,
} from '../src/core/config.js';

describe('parseConfig', () => {
  it('fills in defaults for an empty config', () => {
    const config = parseConfig({});

    expect(config.version).toBe(1);
    expect(config.adapters).toEqual({});
    expect(config.sync).toEqual({});
    expect(config.team.enabled).toBe(false);
    expect(config.team.path).toBe('.envsync.vault');
    expect(config.team.members).toEqual([]);
    expect(config.settings.defaultConflict).toBe('prompt');
    expect(config.settings.color).toBe(true);
  });

  it('applies adapter defaults', () => {
    const config = parseConfig({
      adapters: {
        local: { type: 'dotenv', name: 'local' },
      },
    });

    const adapter = config.adapters['local']!;
    expect(adapter.type).toBe('dotenv');
    expect(adapter.enabled).toBe(true);
    expect(adapter.include).toEqual(['*']);
    expect(adapter.exclude).toEqual([]);
    if (adapter.type === 'dotenv') {
      expect(adapter.path).toBe('.env');
      expect(adapter.backup).toBe(true);
      expect(adapter.mode).toBe(0o600);
    }
  });

  it('keeps adapter-specific fields', () => {
    const config = parseConfig({
      adapters: {
        prod: {
          type: 'doppler',
          name: 'prod',
          project: 'my-project',
          config: 'prd',
          transform: { prefix: 'APP_', uppercase: true },
        },
      },
    });

    const adapter = config.adapters['prod']!;
    expect(adapter.type).toBe('doppler');
    if (adapter.type === 'doppler') {
      expect(adapter.project).toBe('my-project');
      expect(adapter.config).toBe('prd');
    }
    expect(adapter.transform.prefix).toBe('APP_');
    expect(adapter.transform.uppercase).toBe(true);
    expect(adapter.transform.suffix).toBe('');
  });

  it('rejects an unknown adapter type', () => {
    expect(() => parseConfig({ adapters: { x: { type: 'not-a-thing', name: 'x' } } })).toThrow();
  });

  it('rejects an adapter that is missing a required field', () => {
    expect(() =>
      parseConfig({ adapters: { prod: { type: 'doppler', name: 'prod' } } })
    ).toThrow(/project/i);
  });

  it('rejects a sync operation without destinations', () => {
    expect(() =>
      parseConfig({ sync: { push: { source: 'local', destinations: [] } } })
    ).toThrow();
  });

  it('applies sync defaults', () => {
    const config = parseConfig({
      sync: { push: { source: 'local', destinations: ['prod'] } },
    });

    const sync = config.sync['push']!;
    expect(sync.conflict).toBe('prompt');
    expect(sync.dryRun).toBe(true);
    expect(sync.backup).toBe(true);
    expect(sync.validate).toBe(true);
  });

  it('rejects an invalid conflict strategy', () => {
    expect(() =>
      SyncConfigSchema.parse({
        source: 'a',
        destinations: ['b'],
        conflict: 'yolo',
      })
    ).toThrow();
  });
});

describe('AdapterConfigSchema', () => {
  it.each([
    ['dotenv', { path: '.env.local' }],
    ['1password', { vault: 'Engineering', item: 'API Keys' }],
    ['doppler', { project: 'p', config: 'dev' }],
    ['infisical', { projectId: 'pid', environment: 'dev' }],
    ['github-actions', { repo: 'owner/repo' }],
    ['vercel', { projectId: 'prj_1' }],
    ['netlify', { siteId: 'site_1' }],
    ['docker', { envFile: '.env.docker' }],
    ['kubernetes', { secretName: 'app-secrets', namespace: 'prod' }],
  ])('accepts a %s adapter', (type, extra) => {
    const parsed = AdapterConfigSchema.parse({ type, name: `${type}-adapter`, ...extra });

    expect(parsed.type).toBe(type);
    expect(parsed.name).toBe(`${type}-adapter`);
  });

  it('has a schema for every implemented adapter type', () => {
    const required: Array<[AdapterType, Record<string, unknown>]> = [
      [AdapterType.DOTENV, {}],
      [AdapterType.ONEPW, {}],
      [AdapterType.DOPPLER, { project: 'p' }],
      [AdapterType.INFISICAL, { projectId: 'pid' }],
      [AdapterType.GITHUB_ACTIONS, { repo: 'owner/repo' }],
      [AdapterType.VERCEL, { projectId: 'prj_1' }],
      [AdapterType.NETLIFY, { siteId: 'site_1' }],
      [AdapterType.DOCKER, {}],
      [AdapterType.KUBERNETES, { secretName: 'app-secrets' }],
    ];

    for (const [type, extra] of required) {
      expect(() => AdapterConfigSchema.parse({ type, name: 'x', ...extra })).not.toThrow();
    }
  });
});

describe('ConfigSchema', () => {
  it('accepts the shipped default config', () => {
    expect(() => ConfigSchema.parse(defaultConfig)).not.toThrow();
  });

  it('requires a project name when a project block is present', () => {
    expect(() => ConfigSchema.parse({ project: {} })).toThrow();
  });

  it('validates team member emails and roles', () => {
    expect(() =>
      ConfigSchema.parse({
        team: {
          members: [{ name: 'Alice', email: 'not-an-email', publicKey: 'age1x' }],
        },
      })
    ).toThrow(/email/i);
  });
});
