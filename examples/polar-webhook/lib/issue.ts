// lib/issue.ts
// Shared helper: sign an envsync offline license with the seller's private key.
// Uses Node's built-in crypto only.

import { sign, randomUUID } from 'node:crypto';

export interface IssueInput {
  email: string;
  plan: string;
  expiresAt?: string | null;
}

export interface IssuedLicense {
  version: 1;
  payload: {
    id: string;
    email: string;
    plan: string;
    issuedAt: string;
    expiresAt: string | null;
  };
  signature: string;
}

export function issueLicense(privateKeyPem: string, input: IssueInput): IssuedLicense {
  const payload = {
    id: randomUUID(),
    email: input.email,
    plan: input.plan,
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
  };

  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (payload as Record<string, unknown>)[key];
        return acc;
      }, {})
  );

  const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem).toString('base64');

  return { version: 1, payload, signature };
}
