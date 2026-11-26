# Polar.sh webhook → envsync license issuer (example)

This is a minimal Vercel serverless function that turns a paid Polar order into an
envsync offline license file and emails it to the buyer. Adapt it to any host
(Cloudflare Workers, AWS Lambda, …) — the only Polar-specific part is the
signature verification in `src/core/webhook.ts`.

## Flow

1. Buyer clicks "Buy" on your landing page → your backend creates a Polar checkout
   (see `create-checkout.ts`) and redirects the buyer.
2. Buyer pays on Polar.
3. Polar sends an `order.paid` webhook to `/api/webhook`.
4. This function verifies the signature, issues a signed license with your private
   key, and emails it to the buyer.
5. Buyer runs `envsync license import <file>`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `POLAR_WEBHOOK_SECRET` | yes | From Polar dashboard → Settings → Webhooks |
| `ENVSYNC_LICENSE_PRIVATE_KEY` | yes | PEM contents of `license.private.pem` (the seller's private key) |
| `POLAR_API_BASE` | no | Override API base (default `https://api.polar.sh`; use `https://sandbox-api.polar.sh` for sandbox) |
| `RESEND_API_KEY` | no | If set, the license file is emailed; otherwise it is only logged |
| `FROM_EMAIL` | no | Sender address for the email (default `licenses@example.com`) |

## Files

- `api/webhook.ts` — receives and verifies the Polar webhook, issues the license.
- `api/create-checkout.ts` — creates a Polar checkout session (redirects buyer).
- `lib/issue.ts` — shared license-issuing helper (uses Node crypto, no deps).

## Setup

1. Create a product + price on Polar (sandbox first).
2. Generate a key pair: `envsync license keygen --out ./keys`
3. Set `ENVSYNC_LICENSE_PRIVATE_KEY` to the contents of `keys/license.private.pem`.
4. Put `keys/license.public.pem`'s contents into `DEFAULT_PUBLIC_KEY` in
   `src/core/offline-license.ts` (or set `ENVSYNC_LICENSE_PUBLIC_KEY` at build time)
   and rebuild/publish the CLI so buyers can verify.
5. Deploy this example to Vercel, set the env vars, register the webhook URL in
   Polar (subscribe to `order.paid`).
6. Test with `polar webhook trigger order.paid` (Polar CLI) against your local
   dev server.

## Manual fallback

If you do not want to run a server, skip the webhook entirely: watch Polar orders
in the dashboard and run

    envsync license issue --key license.private.pem --email buyer@example.com --plan personal --out buyer-license.json

then email the file. The CLI already supports this.
