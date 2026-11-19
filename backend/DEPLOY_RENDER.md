# Deploy FIRE COUNSEL to Render (website + API, Free plan)

One Render web service serves both the public website and the `/api/` routes,
because the website only calls the API on its own address.

1. Open the Blueprint link:
   https://render.com/deploy?repo=https://github.com/VICTORIOUS-TECH-001/Fire-counsel-
   Sign in with GitHub and allow access to `Fire-counsel-`. Pick the branch that
   contains this `render.yaml` (`main` once the pull request is merged).
2. Fill the secret boxes Render asks for:
   - `DATABASE_URL` — full Neon pooled connection string (password visible).
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase console → Project settings →
     Service accounts → Generate new private key; paste the whole file content.
3. Click **Deploy Blueprint**. When it is live, open
   `https://<service>.onrender.com/api/health` — it should say
   `"database":"connected"`.
4. Firebase console → Authentication → Settings → Authorized domains → add
   `<service>.onrender.com` so sign-in works on the new address.

Notes: Render Free sleeps after 15 minutes idle (first visit can take ~1
minute). Student profiles stay off (`STUDENT_PROFILES_ENABLED=false`) until the
migration is applied. Staging only — not for real student data yet.

## Enable AI answers and reliable online retrieval

This is not required to serve the static shell. On the **actual API service**,
privately configure a writer key (`GROQ_API_KEY`, `GEMINI_API_KEY` or
`OPENROUTER_API_KEY`) and search (`TAVILY_API_KEY` and/or
`BRAVE_SEARCH_API_KEY`). Groq + Tavily/Brave works for text without Gemini;
Groq alone does not search online. The Blueprint prefers Groq and independent
Tavily → Brave → Gemini retrieval. Unused providers may remain blank.

Use **Save and deploy**, confirm the successful **Live** commit, then inspect
`/api/health` diagnostic version **2**. Presence flags do not validate keys.
Sign in as the existing Google admin → **AI studio settings → Test AI
connection**, with **also test web search** selected, to spend provider quota
on writer and source-result checks. API access/model availability/pricing are
account-specific; no credits or billing activation are included. Existing AI
tables and Premium/admin authorization remain required for student jobs.

For exact variables, group/override troubleshooting, error codes and the
limits of synthetic tests, follow [DEPLOYMENT.md section 5](../DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys).
