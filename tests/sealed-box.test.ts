import { describe, it, expect } from 'vitest';
import sodium from 'libsodium-wrappers';
import { sealSecret } from '../src/core/sealed-box.js';

describe('sealSecret', () => {
  it('produces a sealed box that the matching private key can open', async () => {
    await sodium.ready;
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const plaintext = 'sk_live_super-secret-value';

    const sealed = await sealSecret(plaintext, publicKeyBase64);

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      publicKey,
      privateKey
    );
    expect(sodium.to_string(opened)).toBe(plaintext);
  });

  it('does not return the plaintext base64 encoded (GitHub requires real encryption)', async () => {
    await sodium.ready;
    const { publicKey } = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const plaintext = 'sk_live_super-secret-value';

    const sealed = await sealSecret(plaintext, publicKeyBase64);

    expect(sealed).not.toBe(Buffer.from(plaintext).toString('base64'));
  });

  it('uses a fresh ephemeral key so identical values produce different ciphertext', async () => {
    await sodium.ready;
    const { publicKey } = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);

    const first = await sealSecret('same-value', publicKeyBase64);
    const second = await sealSecret('same-value', publicKeyBase64);

    expect(first).not.toBe(second);
  });

  it('rejects a public key that is not 32 bytes', async () => {
    await expect(sealSecret('value', 'AAAA')).rejects.toThrow(/public key/i);
  });

  it('rejects a public key that is not valid base64', async () => {
    await expect(sealSecret('value', 'not base64!!')).rejects.toThrow(/public key/i);
  });
});
