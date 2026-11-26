import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { GitHubActionsAdapter } from '../src/adapters/github-actions.js';
import { AdapterType, SecretFormat } from '../src/core/index.js';
import type { GitHubActionsAdapterConfig } from '../src/core/config.js';

const config: GitHubActionsAdapterConfig = {
  type: AdapterType.GITHUB_ACTIONS,
  name: 'gh-repo',
  enabled: true,
  token: 'test-token',
  repo: 'owner/repo',
  level: 'repository',
  include: ['*'],
  exclude: [],
  transform: { prefix: '', suffix: '', uppercase: false, lowercase: false },
};

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

describe('GitHubActionsAdapter.write', () => {
  let calls: RecordedCall[];
  let publicKey: Uint8Array;
  let privateKey: Uint8Array;
  let keyBase64: string;

  beforeEach(async () => {
    await sodium.ready;
    ({ publicKey, privateKey } = sodium.crypto_box_keypair());
    keyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    calls = [];

    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : undefined,
      });

      if (String(url).endsWith('/actions/secrets/public-key')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ key_id: 'key-1', key: keyBase64 }),
        } as Response;
      }

      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({}),
      } as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads a sealed box that GitHub can open with its private key', async () => {
    const adapter = new GitHubActionsAdapter(config);
    expect((await adapter.initialize(config)).success).toBe(true);

    const value = 'postgres://user:p@ss@db:5432/app';
    const result = await adapter.write({
      format: SecretFormat.DOTENV,
      path: '.env',
      entries: [{ key: 'DATABASE_URL', value, isSecret: true }],
    });

    expect(result.success).toBe(true);

    const put = calls.find((call) => call.method === 'PUT');
    expect(put).toBeDefined();

    const body = JSON.parse(put!.body!);
    expect(body.key_id).toBe('key-1');

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey
    );
    expect(sodium.to_string(opened)).toBe(value);
  });

  it('fails instead of uploading plaintext when the public key is invalid', async () => {
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      if (String(url).endsWith('/actions/secrets/public-key')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ key_id: 'key-1', key: 'not-a-real-key' }),
        } as Response;
      }
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({}) } as Response;
    });

    const adapter = new GitHubActionsAdapter(config);
    await adapter.initialize(config);

    const result = await adapter.write({
      format: SecretFormat.DOTENV,
      path: '.env',
      entries: [{ key: 'API_KEY', value: 'secret', isSecret: true }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/public key/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});
