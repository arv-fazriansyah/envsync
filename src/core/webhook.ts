import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent {
  eventName: string;
  webhookId?: string;
  data: {
    type?: string;
    id?: string;
    attributes?: Record<string, unknown>;
  };
  raw: unknown;
}

/**
 * Verify a LemonSqueezy webhook signature.
 *
 * LemonSqueezy sends `X-Signature: <hex hmac-sha256 of the raw body>`.
 * Always pass the raw request body, never the re-serialised JSON.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!secret || !signature) return false;
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (signature.length !== expected.length) return false;

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Parse a webhook payload into the small shape envsync needs.
 */
export function parseWebhookEvent(rawBody: string): WebhookEvent {
  let parsed: any;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Invalid JSON webhook payload');
  }

  const eventName = parsed?.meta?.event_name;
  if (typeof eventName !== 'string' || eventName.length === 0) {
    throw new Error('Webhook payload is missing meta.event_name');
  }

  return {
    eventName,
    webhookId: typeof parsed?.meta?.webhook_id === 'string' ? parsed.meta.webhook_id : undefined,
    data: {
      type: typeof parsed?.data?.type === 'string' ? parsed.data.type : undefined,
      id: parsed?.data?.id !== undefined && parsed?.data?.id !== null ? String(parsed.data.id) : undefined,
      attributes:
        parsed?.data?.attributes && typeof parsed.data.attributes === 'object'
          ? parsed.data.attributes
          : {},
    },
    raw: parsed,
  };
}

/**
 * One-line summary for logs. Never prints the full payload.
 */
export function describeWebhookEvent(event: WebhookEvent): string {
  const id = event.data.id ?? 'unknown';
  const status = event.data.attributes?.['status'];
  const statusSuffix = typeof status === 'string' ? ` (${status})` : '';

  return `${event.eventName}: ${event.data.type ?? 'event'} #${id}${statusSuffix}`;
}
