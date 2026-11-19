# Google sign-in, admin usage and Neon setup

These are owner-operated deployment steps, not actions performed by the local tests. Keep keys, service-account JSON and database URLs out of chat and Git. Review the existing project, back up the target database and test in disposable staging first.

## 1. Google-only account access

- `/study.html` and `/ai.html` require a Google session. There is no email/password sign-in, email registration or anonymous-continue option. Signing out locks both pages.
- The API independently verifies the Firebase token (including revocation) and requires `firebase.sign_in_provider == "google.com"`. Merely having a linked Google identity is not sufficient; an old password/custom/anonymous session receives `403 GOOGLE_SIGN_IN_REQUIRED`. Administrators must also sign in with Google and still need their existing `admin: true` claim.
- Firestore/Storage rules apply the same Google-session requirement to private access and writes. Public homepage content, slide-image reads and published student pages remain public. Review and deploy the updated rules after the emulator gate passes; tests do not deploy them.
- A browser that previously signed in with Google may open its **local study tools offline** when Firebase cannot load. This is not offline API authorization: protected requests still need a valid token. Explicit sign-out clears this convenience marker, not study records or the separate profile-installation binding.

Owner checklist:

1. Firebase Console → **Authentication → Sign-in method → Google**: enable it and select a support email.
2. Under **Authentication → Settings → Authorized domains**, add the actual website hostname (no scheme/path/port).
3. Supply the public Web `apiKey` in `firebase/firebase-config.mjs`; never put a service-account/private key there. Configure the backend's matching `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` privately.
4. Before disabling other providers or rolling out the enforcement, confirm that the administrator can sign in with Google using the **existing Firebase UID/admin claim**. Recover/link any password-only legacy account through a trusted owner-controlled process; do not delete/recreate accounts or grant admin based only on a matching email.
5. Disable **Email/Password** and any other unused sign-in providers in Firebase. Removing this app's form does not change Firebase Console settings.

For the full provider/domain/MFA guide, see [firebase/README.md](firebase/README.md).

## 2. Fix “Create Neon Branch” HTTP 401

This check authenticates to the **Neon management API**. It does not use Firebase or the PostgreSQL connection password. A 401 means its Neon API credential is missing, invalid, expired or not usable for that request; the workflow output alone does not identify which one.

1. In the Neon Console, select the existing project. Copy its **Project ID** from the project settings; this is not the display name or a connection string.
2. Open Neon account/organization settings → **API keys**. Create or replace a key authorized to manage branches in that project. Copy it directly into GitHub's secret form; do not paste it into chat or a source file.
3. Open this repository on GitHub → **Settings → Secrets and variables → Actions**.
4. On the **Secrets** tab, choose **New repository secret** (or update the existing secret):
   - Name: `NEON_API_KEY`
   - Value: the Neon API key.
5. On the **Variables** tab, choose **New repository variable** (or update it):
   - Name: `NEON_PROJECT_ID`
   - Value: the existing Neon project ID.
6. Open **Actions → Create/Delete Branch for Pull Request → the failed run → Re-run failed jobs**.

Use repository Actions settings, not Dependabot/Codespaces secrets or an unattached environment. If 401 persists, replace the key and verify its account/organization/project permissions. Do not log credentials or weaken pull-request secret protections to debug it.

## 3. Run the database migration after merge

This is separate from the preview-branch check. It uses a PostgreSQL connection URL, **not** `NEON_API_KEY`.

1. After merging the reviewed PR, open the target database in Neon and copy its connection string for the correct database/role/branch. Use the same target as the backend service's `DATABASE_URL`. Confirm it is the intended staging or approved deployment database before running anything.
2. GitHub repository → **Settings → Secrets and variables → Actions → Secrets → New repository secret** (or update):
   - Name: `DATABASE_URL`
   - Value: the complete Neon PostgreSQL connection string. Preserve the SSL options. Do not share the URL; it includes a database password.
3. Go to **Actions → Neon database migration (AI, website, uploads)**.
4. Choose **Run workflow → Use workflow from: main → Run workflow**. If the button/workflow is absent, confirm the PR containing `.github/workflows/neon-migrate.yml` has been merged into the default branch and that your repository role can run Actions.
5. Open the new run and its **migrate** job. Success logs include `Applied 005_premium.sql` and `Tables present (12/12)`. All four reviewed migrations (`002`–`005`) run; they are additive and idempotent, not a database reset.
6. Deploy/redeploy the matching app/backend code, sign in as the administrator with Google and check **Users & AI limits**. The premium checkbox requires migration `005`.

**Not included:** `001_student_profiles.sql` still needs separate review against the actual `app_users` schema, manual application and `STUDENT_PROFILES_ENABLED=true` before private profile/material routes can be enabled. Do not assume the AI migration workflow creates or enables those student profiles.

The automatic PR workflow creates a temporary preview branch; the migration workflow instead changes whichever database `DATABASE_URL` identifies. It does not automatically choose that PR branch.

## 4. Where the administrator sees students and usage

Open `/admin.html`, sign in with the Google account carrying the server-issued admin claim, then select **Users & AI limits**:

- Accounts are listed from Firebase Authentication, including students who have not made an AI request. The current list is capped at 5,000 and reports when truncated.
- Each row shows the name/email, Active/Offline status and last seen time, and today's **Chats / Cases / Notes / Questions** used versus the effective limits.
- Counts come from server-side `ai_usage`, include in-progress reservations and exclude failed requests and earlier days. Day boundaries follow `AI_TIMEZONE` (default `Africa/Lagos`).
- **Change limits** lets the admin grant/revoke Premium, pause AI and set per-account daily overrides. Signing in never grants premium or administrator rights automatically.
- Use **Refresh** to reload the list. Signing out clears it; a delayed response cannot restore another session's account data.

Live prerequisites: matching Firebase Admin credentials with user-list access, the correct Neon `DATABASE_URL`, and migrations `002`–`005`. Local browser/API tests use synthetic users and in-memory/stub data and do not establish that these production services are configured.

## 5. Groq/Tavily still show `false` after saving keys

`/api/health` checks **environment-variable presence in the running API process**, not whether Groq/Tavily accepted a credential. A nonempty unprefixed Tavily key is accepted by this code (with a format warning); it is not silently classified as missing. Groq deliberately refuses an xAI `xai-` credential because that belongs to a different provider.

For the service currently identified as **`fire-counsel-2`**:

1. Open [Render](https://dashboard.render.com/) → **fire-counsel-2 → Environment**. Set `GROQ_API_KEY` and `TAVILY_API_KEY` as **environment variables**, with only their respective key values. A key saved only in GitHub Actions, another service, or a secret file is not a variable in this process. This provider layer does not read arbitrary `/etc/secrets/` files.
2. **A new environment group is not required.** If using an existing group, go to this service's **Linked Environment Groups**, select it and press **Link**. Merely creating/editing a group does not attach it. Even a project-environment-scoped group still needs linking.
3. Check just these two names for duplicates. A service-level variable **always overrides** the same name in a group, including a stale/blank service value. Conflicting names in several groups have no guaranteed precedence. Keep one authoritative value for each key; do not delete unrelated settings/groups. These precedence rules are documented in [Render's guide](https://render.com/docs/configure-environment-variables#linking-a-group-to-a-service).
4. Choose **Save and deploy** (a rebuild is optional for runtime secrets) or **Save, rebuild, and deploy**. Under **Events**, verify that the new deployment actually becomes **Live**. A failed build/deploy can leave the previous instance answering requests.
5. After deploying this diagnostic code, open [the live health endpoint](https://fire-counsel-2.onrender.com/api/health). It includes `config_diagnostics_version: 1`, `render_service`, and `render_commit` when Render supplies a valid commit SHA. Compare that SHA with the successful live deployment. If the new version field is absent, this code is not serving that response yet.
6. `ai_key_check.groq.state` and `.tavily.state` report the **canonical setting's** `missing`, `empty` or `present` status. `setup.groq_key` / `setup.tavily_key` also account for supported aliases. No values, key fragments or hashes are exposed. `present` is not proof of provider validity.
7. Once presence is true, use **Admin → AI studio settings → Test AI connection**, including **also test web search**, to distinguish accepted credentials from provider authentication/quota errors. Never share the keys or raw environment output to debug this.

A `status: ok` response means the configured **database health check** succeeded. It does not test Firebase sign-in, deployed Firestore rules, provider authentication or group linkage. The repository's `render.yaml` declarations also do not prove that an already-created dashboard service received the values.

## 6. Manually publish the Firebase rules

A Firestore `permission-denied` reply is an authorization/validation denial, not proof that Firebase is disconnected. The server's `firebase_admin_key: true` flag only validates the service-account file **locally**; it does not inspect the live project's rules or grant a custom claim.

1. Open [Firebase Console → fire-counsel](https://console.firebase.google.com/project/fire-counsel/overview). Back up the existing rules and review any paths used by other apps in that project before replacing them.
2. Open **Build → Firestore Database**, select the **`(default)` database → Rules**. Replace the editor with the complete contents of [`firebase/firestore.rules`](firebase/firestore.rules), then press **Publish**. Do not paste Storage rules into this editor. The browser uses `siteContent/public` in this default database.
3. Only for Firebase Storage operations: open **Build → Storage → Rules** for **`fire-counsel.firebasestorage.app`**. Paste the complete, separate [`firebase/storage.rules`](firebase/storage.rules), then **Publish**. Current admin photo uploads use Neon `/media/`, not Storage, so changing Storage rules/billing does not fix a Firestore content-publish denial.
4. Sign in at `/admin.html` with the intended **Google** administrator. The verified email must be in Render's `ADMIN_EMAILS` if it needs the one-time **Make this account the administrator** button. That button calls the protected server endpoint and refreshes the ID token. Rules publishing alone **cannot** add `admin: true`; never put administrator emails or private keys into public rules to bypass the claim.
5. Reload after rules propagation, then publish a small, reversible content change. This client refreshes and checks the Google/admin token before a write and reports schema validation before contacting Firestore. If a freshly verified Google-admin write is still denied, confirm the console project/database, the deployed rules version and any separately enforced App Check configuration. Do not enable allow-all/test-mode rules.

The matching code fixes are also required: stored `updatedAt`/`updatedBy` metadata is removed **only on reads**, the optional public `workspace` map is accepted by client validation and rules, and all publish/restore paths update Firestore before the Neon archive. Both the homepage and student workspace read that primary channel, with Neon/bundled/offline fallbacks. A Neon archive failure is reported as partial success; it never falsely reports that an already-live Firebase write was rolled back. No rules, claims, Render settings or private credentials are deployed by local tests.
