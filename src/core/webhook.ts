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
export interface PolarWebhookHeaders {
  'webhook-id'?: string;
  'webhook-timestamp'?: string;
  'webhook-signature'?: string;
}

export interface PolarWebhookEvent {
  type: string;
  timestamp?: string;
  data: Record<string, unknown>;
  raw: unknown;
}

/**
 * Verify a Polar webhook (Standard Webhooks scheme).
 *
 * Polar signs `${webhook-id}.${timestamp}.${rawBody}` with HMAC-SHA256 using
 * either the raw secret bytes or the base64-decoded secret (after `whsec_`).
 * The SDK tries both, so we do too.
 */
export function verifyPolarWebhookSignature(
  rawBody: string,
  headers: PolarWebhookHeaders,
  secret: string,
  options: { now?: () => Date; toleranceSeconds?: number } = {}
): boolean {
  if (!secret) return false;

  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];

  if (!id || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = (options.now ?? (() => new Date()))().getTime();
  const tolerance = (options.toleranceSeconds ?? 5 * 60) * 1000;
  if (Math.abs(now - ts * 1000) > tolerance) return false;

  const signedContent = `${id}.${Math.floor(ts)}.${rawBody}`;

  const keys: Buffer[] = [Buffer.from(secret, 'utf8')];
  const remainder = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const decoded = Buffer.from(remainder, 'base64');
    if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === remainder.replace(/=+$/, '')) {
      const firstKey = keys[0];
  if (firstKey && !decoded.equals(firstKey)) keys.push(decoded);
    }
  } catch {
    // ignore
  }

  const provided = signatureHeader.split(/\s+/).filter(Boolean);

  for (const key of keys) {
    const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
    for (const entry of provided) {
      const [, sig] = entry.split(',');
      if (!sig) continue;
      const version = entry.split(',')[0];
      if (version !== 'v1') continue;
      try {
        const providedBuf = Buffer.from(sig, 'base64');
        const expectedBuf = Buffer.from(expected, 'base64');
        if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
          return true;
        }
      } catch {
        // ignore malformed
      }
    }
  }

  return false;
}

export function parsePolarWebhookEvent(rawBody: string): PolarWebhookEvent {
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Invalid JSON webhook payload');
  }

  const type = parsed?.type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('Webhook payload is missing type');
  }

  return {
    type,
    timestamp: typeof parsed?.timestamp === 'string' ? parsed.timestamp : undefined,
    data: parsed?.data && typeof parsed.data === 'object' ? parsed.data : {},
    raw: parsed,
  };
}

export function describeWebhookEvent(event: WebhookEvent): string {
  const id = event.data.id ?? 'unknown';
  const status = event.data.attributes?.['status'];
  const statusSuffix = typeof status === 'string' ? ` (${status})` : '';

  return `${event.eventName}: ${event.data.type ?? 'event'} #${id}${statusSuffix}`;
}
