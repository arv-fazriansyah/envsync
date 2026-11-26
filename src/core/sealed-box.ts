import sodium from 'libsodium-wrappers';

/**
 * Encrypt a value as a libsodium sealed box, as required by the GitHub Actions
 * secrets API (`encrypted_value` must be a base64 sealed box for the repo /
 * environment / organization public key).
 *
 * A sealed box uses an ephemeral key pair, so the ciphertext can only be opened
 * by GitHub's private key and is different on every call.
 */
export async function sealSecret(plaintext: string, publicKeyBase64: string): Promise<string> {
  await sodium.ready;

  let publicKey: Uint8Array;
  try {
    publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error('Invalid public key: not valid base64');
  }

  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error(
      `Invalid public key: expected ${sodium.crypto_box_PUBLICKEYBYTES} bytes, got ${publicKey.length}`
    );
  }

  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
