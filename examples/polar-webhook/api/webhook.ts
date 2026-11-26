// api/webhook.ts  (Vercel serverless function)
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyPolarWebhookSignature, parsePolarWebhookEvent } from '../lib/webhook.js';
// If you deploy this as a standalone project, copy src/core/webhook.ts into lib/.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const secret = process.env.POLAR_WEBHOOK_SECRET;
  const privateKey = process.env.ENVSYNC_LICENSE_PRIVATE_KEY;
  if (!secret || !privateKey) {
    res.status(500).json({ error: 'server not configured' });
    return;
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  const valid = verifyPolarWebhookSignature(
    rawBody,
    {
      'webhook-id': String(req.headers['webhook-id'] ?? ''),
      'webhook-timestamp': String(req.headers['webhook-timestamp'] ?? ''),
      'webhook-signature': String(req.headers['webhook-signature'] ?? ''),
    },
    secret
  );

  if (!valid) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let event: ReturnType<typeof parsePolarWebhookEvent>;
  try {
    event = parsePolarWebhookEvent(rawBody);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'invalid payload' });
    return;
  }

  if (event.type !== 'order.paid') {
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  const data = event.data as {
    id?: string;
    customer_email?: string;
    product_id?: string;
  };

  const email = data.customer_email;
  if (!email) {
    res.status(400).json({ error: 'order has no customer_email' });
    return;
  }

  const { issueLicense } = await import('../lib/issue.js');
  const license = issueLicense(privateKey, { email, plan: 'personal' });
  const licenseJson = JSON.stringify(license, null, 2);

  // Optional: email the license. Uses Resend if RESEND_API_KEY is set.
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const from = process.env.FROM_EMAIL ?? 'licenses@example.com';
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: 'Your envsync license',
        text: `Thanks for your purchase!\n\nSave the attached license as license.json, then run:\n\n  envsync license import license.json\n\n---\n${licenseJson}`,
      }),
    });
  } else {
    // No email provider: log so you can fulfill manually.
    console.log(`[license issued] ${email}: ${license.payload.id}`);
    console.log(licenseJson);
  }

  res.status(200).json({ received: true, licenseId: license.payload.id });
}
