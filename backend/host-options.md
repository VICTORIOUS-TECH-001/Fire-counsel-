# FIRE COUNSEL API host — no-billing comparison

Research snapshot: 14 November 2026. You selected Render Free for a staging prototype only. This file compares options; no account was created, no payment method was added and nothing was deployed.

## Recommendation

**Render Free is the closest fit for a development-only Express prototype** because it accepts ordinary Node.js web services and requires no payment for a free deploy. It is not suitable for a production student service: Render says not to use free instances for production, and the web service sleeps after 15 minutes idle and can take about a minute to wake. Each workspace receives 750 free instance-hours monthly; if limits are exceeded without a payment method, service/build activity is suspended rather than billed. [Render free instances](https://render.com/docs/free) · [Render FAQ](https://render.com/docs/faq) · [Render first deploy](https://render.com/docs/your-first-deploy)

Use it only for a disposable/staging integration after explicit approval. Keep real student data, AI prompts, payment processing, production admin access and Firebase writes disabled until a production-ready host and its terms are reviewed.

## Alternatives

| Host | Fit for the existing Express API | No-billing caveats | Assessment |
|---|---|---|---|
| **Render Free** | Native Node web-service deployment; minimal changes to the current Express server. | Sleeps after 15 minutes idle, takes about a minute to wake, has 750 free service-hours per workspace per month, ephemeral disk, and is explicitly not for production. Without a payment method, some exhausted quotas pause/suspend service or builds. [Docs](https://render.com/docs/free) | Best for an approved prototype only; not a live student backend. |
| **Koyeb Free** | Can run a Node web service, but the free instance is constrained to 512 MB RAM, 0.1 vCPU and 2 GB disk; it scales to zero after one hour. | Koyeb says Free instances are for testing/hobby work, not production, and organization creation asks for payment information. [Instances](https://www.koyeb.com/docs/reference/instances) · [Organizations](https://www.koyeb.com/docs/reference/organizations) | Not the clearest choice for a strict no-billing/no-payment-info requirement. |
| **Vercel Hobby** | Vercel supports Express by running the app as a Vercel Function, so this is not an always-on Express server. [Express guide](https://vercel.com/docs/frameworks/backend/express) | Hobby is restricted to personal/non-commercial use under Vercel's terms; its free usage is capped. [Terms](https://vercel.com/legal/terms) · [Hobby plan](https://vercel.com/docs/plans/hobby) | Not recommended for this student-facing service unless the terms and intended use are confirmed. |
| **Cloudflare Workers Free** | Requires adapting the app to a Worker runtime and testing dependencies; Node compatibility is partial rather than a standard Node server. [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) | The Free plan lists 100,000 requests/day and 10 ms CPU time per invocation; exceeding Free limits can make requests fail. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) | Potential low-cost path only if you approve a runtime/architecture rewrite; not a drop-in host for the current Express app. |

## Safe next step

If you approve, adapt and test the current Express foundation on Render Free **only as a staging prototype**, using server-side environment secrets, placeholder data and no real student prompts or payment credentials. Do not select a paid instance, add a payment method, enable billing, upload to Firebase Storage, or connect production users without separate explicit approval.
