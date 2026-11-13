# Stripe setup (one time, platform owner)

Agencies connect their own Stripe accounts from **Settings → Integrations → Connect Stripe** (Stripe Connect, Standard
accounts, OAuth). Clients then pay invoices on Stripe Checkout; the money goes straight to the agency's Stripe account.
Stripe Connect Standard has no extra platform fee — agencies pay normal Stripe processing fees on their own account.

Until the variables below are set, the live site shows Stripe as "Not available yet" and the pay page says online card
payment isn't set up. Local dev without them keeps the simulated card form.

## 1. Stripe dashboard (your platform account)

1. **Connect → Get started**: enable Connect and choose *Standard* accounts / *OAuth*.
2. **Connect → Settings → OAuth**: copy the **client ID** (`ca_…`). Add this redirect URI:
   `https://portal.voicechart.app/api/v1/integrations/stripe/callback`
   (and `http://localhost:3100/api/v1/integrations/stripe/callback` in test mode for local testing).
3. **Developers → Webhooks → Add endpoint**, choose **"Events on Connected accounts"**:
   - URL: `https://portal.voicechart.app/api/v1/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
     `charge.refunded`, `charge.dispute.created`, `account.updated`, `account.application.deauthorized`
   - Copy the **signing secret** (`whsec_…`).
4. **Developers → API keys**: the platform **secret key** (`sk_live_…`, or `sk_test_…` to try it in test mode first).

## 2. Railway → `@veyro/api` → Variables (you type these yourself)

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | platform secret key |
| `STRIPE_CONNECT_CLIENT_ID` | `ca_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the Connect webhook |
| `INTEGRATIONS_ENCRYPTION_KEY` | output of `openssl rand -base64 32` — encrypts stored provider tokens; keep it, changing it breaks existing connections |

Test-mode keys and live keys are separate: an account connected in test mode must reconnect after switching to live keys.

## Local testing

Put the same four variables (test mode) in `apps/api/.env` (gitignored), then forward webhooks with the Stripe CLI:

```bash
stripe listen --forward-connect-to localhost:4100/api/v1/webhooks/stripe
```

Use the `whsec_…` that `stripe listen` prints as `STRIPE_WEBHOOK_SECRET`. Test card: `4242 4242 4242 4242`.

## How it works

- `apps/api/src/adapters/stripe.ts`: Stripe REST client, OAuth, webhook signature check, per-workspace connection store.
- `apps/api/src/modules/finance-stripe.ts`: connect/callback routes, Checkout, refunds, webhook handling, Test and Sync.
- `integration_credentials` (migration 0770): one row per workspace; tokens are AES-256-GCM encrypted
  (`apps/api/src/core/secrets.ts`); the `acct_…` id stays in clear so webhooks find their workspace.
- Payments are recorded once each (idempotency key `stripe:<checkout session id>`), whether they arrive by webhook,
  by the client's return to the pay page, or by **Sync payments from Stripe** (pulls the last 30 days).
