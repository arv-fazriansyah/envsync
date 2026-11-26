import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  parseWebhookEvent,
  describeWebhookEvent,
} from '../src/core/webhook.js';

const SECRET = 'whsec_test_secret';
const body = JSON.stringify({
  meta: { event_name: 'order_created', webhook_id: 'wh-1' },
  data: {
    type: 'orders',
    id: '42',
    attributes: { status: 'paid', user_email: 'buyer@example.com', total: 7900 },
  },
});

function sign(payload: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature produced with the shared secret', () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = sign(body);

    expect(verifyWebhookSignature(body.replace('7900', '1'), signature, SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed signature', () => {
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'not-hex', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'abc', SECRET)).toBe(false);
  });

  it('rejects everything when the secret is empty', () => {
    expect(verifyWebhookSignature(body, sign(body), '')).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('extracts the event name and data', () => {
    const event = parseWebhookEvent(body);

    expect(event.eventName).toBe('order_created');
    expect(event.webhookId).toBe('wh-1');
    expect(event.data.type).toBe('orders');
    expect(event.data.id).toBe('42');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWebhookEvent('{nope')).toThrow(/invalid json/i);
  });

  it('throws when meta.event_name is missing', () => {
    expect(() => parseWebhookEvent(JSON.stringify({ data: {} }))).toThrow(/event_name/);
  });
});

describe('describeWebhookEvent', () => {
  it('summarises an order event for logs without leaking the raw payload', () => {
    const summary = describeWebhookEvent(parseWebhookEvent(body));

    expect(summary).toContain('order_created');
    expect(summary).toContain('42');
    expect(summary).toContain('paid');
  });
});
