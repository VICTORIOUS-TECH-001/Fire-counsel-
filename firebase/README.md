# Firebase browser configuration and Auth

`firebase/firebase-config.mjs` is the Web configuration the browser actually loads.
It already names the `fire-counsel` project, Auth domain, bucket, app ID and
measurement ID. The Web API key is still a placeholder until you paste `apiKey`
from **Firebase Console → Project settings → General → Your apps → Config**.
Commit that public key with the site. It identifies the app; it is not an admin
credential and it does not replace Security Rules or the Admin SDK.

`client.mjs` initializes the Firebase Web SDK only after that key is present.
`auth-client.mjs` implements email/password registration/sign-in, Google popup
sign-in (redirect when the popup is blocked or the page is inside a frame),
sign-out, a Google Authenticator (TOTP) second step when Firebase asks for one,
verification/reset emails, reauthenticated password changes and verified email
changes. It supplies Firebase ID-token headers and a persisted installation
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

The Google button and `signInWithGoogle()` already exist in this repository.
They call Firebase Auth's Google provider. Enabling Google in the console is
required, but it is not sufficient: the published page must load a real Web
API key, and the hostname you open must be an authorized domain. Do not create
a second Firebase project, change billing, deploy rules or upload student data
just to turn the provider on.

1. Open **Firebase Console → fire-counsel → Authentication → Sign-in method**.
   If Authentication has not been initialized, use **Get started** first.
2. Open **Google**, turn on **Enable**, set the public app name if asked, choose
   the project support email, then **Save**. Firebase creates the OAuth client.
   No Gemini key or OAuth client secret belongs in this frontend.
3. Under **Authentication → Settings → Authorized domains**, add only the exact
   hostname used to open the website. `localhost` and `fire-counsel.firebaseapp.com`
   are the usual defaults. For any other preview or deployed host, copy that
   hostname only — no `https://`, port or path. Do not add wildcards.
4. In **Google Cloud Console → APIs & Services → OAuth consent screen**, if the
   app is in **Testing**, add every Google account that should sign in as a test
   user (or publish the app). Otherwise Google refuses the account even though
   Firebase shows Google as enabled. Also confirm the browser API key allows
   this site and the Identity Toolkit API (**APIs & Services → Credentials**).
5. Open **Project settings → General → Your apps → Config**. In
   `firebase/firebase-config.mjs`, replace `REPLACE_WITH_FIREBASE_WEB_API_KEY`
   with that `apiKey`. Keep `authDomain` as `fire-counsel.firebaseapp.com` unless
   Firebase Hosting gives you a different one. Publish this file with the site.
   The old ignored `firebase-config.local.mjs` is not loaded anymore; a key that
   exists only on one computer never reaches the sign-in page.
6. Open `/auth.html` and choose **Continue with Google**. Allow popups. If the
   page is inside a frame, or the popup is blocked, the same button uses redirect
   sign-in instead. A normal first success creates the user under
   **Authentication → Users**.

### Google Authenticator (TOTP), only if you turned on multi-factor

Google sign-in and the Google Authenticator app are different. The Google
provider does not ask for an authenticator code. A code is required only when
this project uses TOTP multi-factor authentication and that user enrolled it.

Firebase requires all of the following before an authenticator code can work:

- Authentication with **Identity Platform**, which needs billing (Blaze).
- TOTP enabled for the project (Admin SDK `multiFactorConfig` / Identity Platform
  MFA settings). Turning on the Google provider does not do this.
- A verified email on the user. Unverified addresses cannot enroll.
- The user enrolled from a signed-in session: reauthenticate, generate a TOTP
  secret, scan the QR in Google Authenticator, then confirm a 6-digit code.
  This repository does not enroll a factor. It only finishes sign-in when
  Firebase returns `auth/multi-factor-auth-required`.
- The code is 6 digits, changing about every 30 seconds, for the FIRE COUNSEL
  entry in the authenticator app.

If MFA is required for every user, an account that has not enrolled cannot
finish sign-in here. Enroll in a trusted flow first. Phone, anonymous and custom
tokens are not TOTP factors.

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
A placeholder Web API key produces a setup notice on the sign-in page while local study
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

The six security-rule scenarios **passed in the Java 21 GitHub Actions job**
against the demo-project emulators. The emulator command also reruns three local
study-compatibility tests. Java 21+ is still absent from this sandbox, so the
rules command cannot start here; the successful emulator run is remote CI,
not verification of the active Firebase project.

Storage download tests compare the SDK's ArrayBuffer through a Uint8Array.
Deletion tests require student/anonymous permission denials, confirm that those
denials preserve the original bytes, then require admin deletion and the exact
`storage/object-not-found` result. A missing public object is not a permission
denial. No rule or authorization assertion was relaxed to obtain a passing job.

The Java-enabled GitHub Actions rules job is an executed regression gate, **not
a deployment**. Review the active project's settings/current rules and the known
Firebase development dependency advisories/lockfile inconsistencies in
[STATUS.md](../STATUS.md) before considering deployment. Storage uploads remain
disabled; do not force untested major dependency upgrades to hide warnings.
