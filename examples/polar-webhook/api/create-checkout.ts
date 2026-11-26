// api/create-checkout.ts  (Vercel serverless function)
// Creates a Polar checkout session and redirects the buyer.
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  const productId = process.env.POLAR_PRODUCT_ID;
  if (!accessToken || !productId) {
    res.status(500).json({ error: 'server not configured' });
    return;
  }

  const apiBase = process.env.POLAR_API_BASE ?? 'https://api.polar.sh';
  const body = { products: [productId] };
  const response = await fetch(`${apiBase}/v1/checkouts/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    res.status(502).json({ error: 'polar checkout failed', detail: text });
    return;
  }

  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    res.status(502).json({ error: 'no checkout url returned' });
    return;
  }

  res.redirect(303, data.url);
}
