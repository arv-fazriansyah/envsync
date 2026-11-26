import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyPolarWebhookSignature,
  parsePolarWebhookEvent,
} from '../src/core/webhook.js';

const SECRET = 'whsec_test_secret_abc123';
const body = JSON.stringify({
  type: 'order.paid',
  timestamp: '2026-01-01T00:00:00Z',
  data: {
    id: 'order-42',
    customer_email: 'buyer@example.com',
    product_id: 'prod-1',
    amount: 7900,
  },
});

function signPolar(
  body: string,
  secret: string,
  opts: { id?: string; timestamp?: number } = {}
): { id: string; timestamp: string; signature: string } {
  const id = opts.id ?? 'msg-1';
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signedContent = `${id}.${timestamp}.${body}`;
  const key = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = Buffer.from(key, 'base64');
  const hmacKey = keyBytes.length > 0 && keyBytes.toString('base64') === key ? keyBytes : Buffer.from(secret, 'utf8');
  const signature = createHmac('sha256', hmacKey).update(signedContent, 'utf8').digest('base64');
  return { id, timestamp: String(timestamp), signature: `v1,${signature}` };
}

describe('verifyPolarWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const { id, timestamp, signature } = signPolar(body, SECRET);
    expect(
      verifyPolarWebhookSignature(body, {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      }, SECRET)
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { id, timestamp, signature } = signPolar(body, SECRET);
    expect(
      verifyPolarWebhookSignature(body.replace('7900', '1'), {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      }, SECRET)
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const { id, timestamp, signature } = signPolar(body, 'whsec_other');
    expect(
      verifyPolarWebhookSignature(body, {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      }, SECRET)
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(verifyPolarWebhookSignature(body, {}, SECRET)).toBe(false);
  });

  it('rejects an expired timestamp', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const { id, signature } = signPolar(body, SECRET, { timestamp: oldTimestamp });
    expect(
      verifyPolarWebhookSignature(body, {
        'webhook-id': id,
        'webhook-timestamp': String(oldTimestamp),
        'webhook-signature': signature,
      }, SECRET, { now: () => new Date() })
    ).toBe(false);
  });

  it('rejects an empty secret', () => {
    const { id, timestamp, signature } = signPolar(body, SECRET);
    expect(
      verifyPolarWebhookSignature(body, {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      }, '')
    ).toBe(false);
  });
});

describe('parsePolarWebhookEvent', () => {
  it('extracts type and data', () => {
    const event = parsePolarWebhookEvent(body);
    expect(event.type).toBe('order.paid');
    expect(event.data.id).toBe('order-42');
    expect(event.data.customer_email).toBe('buyer@example.com');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePolarWebhookEvent('{nope')).toThrow(/invalid json/i);
  });

  it('throws when type is missing', () => {
    expect(() => parsePolarWebhookEvent(JSON.stringify({ data: {} }))).toThrow(/type/);
  });
});
