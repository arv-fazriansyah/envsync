import { describe, it, expect } from 'vitest';
import {
  requiresLicense,
  adaptersUsedBySyncs,
  FREE_ADAPTER_TYPES,
} from '../src/core/license-gate.js';
import type { Config } from '../src/core/config.js';

function config(
  adapters: Record<string, Record<string, unknown>>,
  sync: Record<string, unknown> = {}
): Config {
  return { version: 1, adapters, sync } as unknown as Config;
}

const adapter = (type: string, name: string, enabled = true) => ({
  type,
  name,
  enabled,
  include: ['*'],
  exclude: [],
  transform: { prefix: '', suffix: '', uppercase: false, lowercase: false },
});

describe('requiresLicense', () => {
  it('treats dotenv as free', () => {
    const result = requiresLicense(
      config({
        local: adapter('dotenv', 'local'),
        staging: adapter('dotenv', 'staging'),
      })
    );

    expect(FREE_ADAPTER_TYPES).toContain('dotenv');
    expect(result.required).toBe(false);
    expect(result.adapters).toEqual([]);
  });

  it('requires a license for cloud adapters', () => {
    const result = requiresLicense(
      config({
        local: adapter('dotenv', 'local'),
        prod: adapter('doppler', 'prod'),
      })
    );

    expect(result.required).toBe(true);
    expect(result.adapters).toEqual(['prod']);
  });

  it('lists every paid adapter once, in config order', () => {
    const result = requiresLicense(
      config({
        doppler: adapter('doppler', 'doppler'),
        vercel: adapter('vercel', 'vercel'),
        onepw: adapter('1password', 'onepw'),
        github: adapter('github-actions', 'github'),
      })
    );

    expect(result.required).toBe(true);
    expect(result.adapters).toEqual(['doppler', 'vercel', 'onepw', 'github']);
  });

  it('ignores disabled adapters', () => {
    const result = requiresLicense(
      config({
        prod: adapter('doppler', 'prod', false),
        local: adapter('dotenv', 'local'),
      })
    );

    expect(result.required).toBe(false);
  });

  it('treats unknown adapter types as paid', () => {
    const result = requiresLicense(config({ future: adapter('future-cloud', 'future') }));
    expect(result.required).toBe(true);
    expect(result.adapters).toEqual(['future']);
  });

  it('scopes the check to the given adapter set', () => {
    const result = requiresLicense(
      config({
        prod: adapter('doppler', 'prod'),
        local: adapter('dotenv', 'local'),
      }),
      { adapters: ['local'] }
    );

    expect(result.required).toBe(false);
  });
});

describe('adaptersUsedBySyncs', () => {
  it('collects source and destinations for one sync', () => {
    const result = adaptersUsedBySyncs(
      config(
        {},
        {
          deploy: { source: 'local', destinations: ['prod', 'github'], conflict: 'source-wins' },
        }
      ),
      ['deploy']
    );

    expect(result).toEqual(['local', 'prod', 'github']);
  });

  it('collects every sync when no names are given', () => {
    const result = adaptersUsedBySyncs(
      config(
        {},
        {
          a: { source: 'local', destinations: ['prod'], conflict: 'source-wins' },
          b: { source: 'local', destinations: ['dev'], conflict: 'source-wins' },
        }
      )
    );

    expect(result).toEqual(['local', 'prod', 'dev']);
  });
});
