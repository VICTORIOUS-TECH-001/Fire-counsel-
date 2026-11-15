# Firebase browser configuration and Auth

`firebase-config.local.mjs` holds the Firebase Web configuration supplied for
`fire-counsel`. Its path is in the repository `.gitignore`; the local config is
not committed. On another machine, copy `firebase-config.example.mjs` to
`firebase-config.local.mjs` and provide the Web API key locally.

`client.mjs` initializes the Firebase Web SDK. `auth-client.mjs` implements
email/password registration/sign-in, Google popup sign-in with redirect fallback,
sign-out, verification/reset emails, reauthenticated password changes and verified
email changes. It supplies Firebase ID-token headers and a persisted installation
marker for protected student same-origin `/api/...` calls. `auth.html` is
the shared sign-in page; the admin page requests `/api/v1/admin/me` and treats
the backend response—not a browser claim—as authoritative. It does not grant
admin claims or enable live edits.

The provided config confirms the project ID, Auth domain, Storage bucket, app
ID and measurement ID. It does **not** verify the live project's Firestore
database ID/location, enabled providers, authorized domains, current deployed
rules, App Check state or existing admin claims. No Firebase settings were
changed remotely.

## Enable Google sign-in

The Google button and provider code already exist. They have not been verified
against the live project. The owner must configure the existing project; do not
create a second project, change billing, deploy rules or upload student data just
to enable this provider.

1. Open **Firebase Console → fire-counsel → Authentication → Sign-in method**.
   If Authentication has not been initialized, use **Get started** first.
2. Choose **Add new provider → Google** (or open the existing Google row), turn
   on **Enable**, set the public-facing app name if requested and select the
   project support email, then **Save**. The standard Firebase Google-provider
   setup normally configures its OAuth client; no Gemini key or OAuth client
   secret belongs in this frontend.
3. Under **Authentication → Settings → Authorized domains**, add only the exact
   hostname used to open the website. For Arena, copy the hostname from the
   **Website** preview's address (not a localhost URL). Enter the hostname only,
   without `https://`, a port or a page path. For development on your own machine,
   add `localhost` explicitly if needed. Add the final deployed hostname only
   when ready; do not add broad parent domains or wildcards.
4. Open **Project settings → General → Your apps**, select the existing Web app,
   and find **SDK setup and configuration → Config**. From the repository root:

   ```bash
   cp firebase/firebase-config.example.mjs firebase/firebase-config.local.mjs
   ```

   Edit that ignored local file privately: provide the Web API key and check
   every field against the same project's Web configuration. Keep the named
   `firebaseConfig` export and use the `authDomain` supplied by Firebase, not an
   improvised preview URL. Never paste a service-account key, OAuth client secret
   or Gemini key into this file or chat. Copying the example alone does not
   configure authentication; its API key is a placeholder.
5. Open the running website's `/auth.html` in a regular browser and choose
   **Continue with Google**, using a dedicated test account. Allow popups for
   the test origin. The code has redirect fallback, but mobile, custom-domain
   and third-party-storage behavior still need separate live verification.
6. Check **Authentication → Users** for the test user, sign out, then sign in
   again. A normal first successful Google sign-in creates a Firebase Auth user;
   subsequent sign-ins reuse it. The UI must not describe this as course
   enrollment or administrator approval.

### Identity is not course access

Google sign-in authenticates the user without this app collecting their Google
password. On first use, the app offers a separate, prefilled **student profile** at
`/study.html#profile`: available name/email/photo come from Firebase. The student
confirms the details and browser-installation warning before the Neon profile is
created. Students can then edit their own profile without selecting any course,
paying, obtaining membership or asking an administrator.

Profile creation does **not** assign a university/course, approve membership,
activate a paid plan, enforce quotas, or grant the `admin: true` claim. The
registered-installation check is a browser marker, not hardware identification;
an IP change does not create an account. Another installation is refused for
that profile, with no automatic transfer or self-service recovery. See the
[profile policy, API and staging setup](../backend/STUDENT_PROFILES.md) for the
important loss/copy/proxy limitations. No automatic account-linking flow is
provided for collisions with another sign-in method.

A trusted project owner must separately grant an administrator claim to the
reviewed Firebase UID. The API verifies Firebase tokens and the claim; a browser
role or email address is never sufficient.

### Email/password registration and secure changes

To use email registration, review **Authentication → Sign-in method →
Email/Password** in the existing project, enable that provider if approved and
review its password policy. No provider setting is changed by this repository.
The Auth page has a **New here? Create a student account** form asking for name,
email and password/confirmation only. Account creation and initial displayName
are Firebase SDK operations; the Neon profile is created later after consent.
Missing ignored Web configuration produces a setup notice while local study
continues to work.

After creating a profile, students can explicitly request email verification.
An unverified account can edit its basic profile but not access protected student
materials/search. Password-backed accounts can reauthenticate with their current
password and change it. New email addresses use Firebase's
`verifyBeforeUpdateEmail`, with password or same-Google-account reauthentication;
complete the verification link and select **Refresh account** to force a fresh
token and sync the current Firebase Admin email into Neon. A linked Google
account's own email/password is not changed by those Firebase contact-email
operations. Google-only accounts have no Firebase password to display or edit.
Forgot-password reset requests use generic responses and are sent by Firebase,
not the API. Passwords never enter Neon or profile JSON.

Firebase Web configuration is enough to attempt these client Auth actions; a
Neon connection and Firebase Admin private key are not required for that SDK
operation. To verify `/api/v1/me`, access a protected admin action or create/edit
a student profile, the backend needs matching Firebase Admin credentials.
Neon-backed profile/content operations additionally require the reviewed schema,
manual staging profile migration and `STUDENT_PROFILES_ENABLED=true`; protected
content still requires its separate access records. The default flag is off and
no migration runs at server startup. Auth pages use same-origin `/api/...` paths;
run the supplied proxy and preserve the installation header. Never place backend
credentials in the Web configuration.

The Web API key is public client configuration, not an admin credential. Restrict
it to approved APIs and website referrers in Google Cloud Console. Never put a
Firebase service-account key, Gemini secret, or other server credential in this
file.

## Local tests and deployment gate

Use Node.js 22.17+ for the complete repository toolchain. From this directory, `npm run test:local` checks that the legacy IndexedDB name,
version, stores and session counter remain unchanged and that service-worker
cleanup does not clear browser study data. `npm run test:rules` runs the Firestore
and Storage suite against local emulators using a `demo-` project ID; it covers
anonymous/student/admin reads and writes, slide upload type/size, public reads,
and admin-only deletion. It never targets the live Firebase project.

The root `npm test` and `npm run test:browser` additionally cover page wiring,
service-worker behavior, preserved legacy study records, API proxy restrictions,
and simulated registration, Google-prefilled profile creation/editing, browser
installation denial, Firebase security, material/search/admin and stale-session
flows. Browser stubs do not test live Firebase sign-in, real provider linking or
verification/reset/change-email delivery. The profile SQL tests use in-memory
PGlite, not Neon; no tests automatically run the migration against a live database.

The rules suite is prepared but has **not** passed in this workspace: the Firebase
Emulator Suite could not start because Java 21+ is not installed (`Could not spawn
java -version`). Do not deploy the proposed rules or enable Firebase Storage
uploads until `npm run test:rules` passes in a Java-enabled environment and the
active project's settings/current rules have been reviewed.

The Java-enabled GitHub Actions rules job is a separate proposed release gate,
not an executed/deployed Firebase change. Known Firebase development dependency
advisories and inherited lockfile inconsistencies are listed in `../STATUS.md`;
they still need review rather than an untested forced major upgrade.
