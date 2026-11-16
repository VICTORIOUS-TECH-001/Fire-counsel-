# Deploy FIRE COUNSEL to Render (website + API, Free plan)

One Render web service serves both the public website and the `/api/` routes,
because the website only calls the API on its own address.

1. Open the Blueprint link:
   https://dashboard.render.com/blueprint/new?repo=https://github.com/VICTORIOUS-TECH-001/Fire-counsel-
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
