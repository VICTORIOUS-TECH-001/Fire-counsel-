# Firebase browser configuration and Auth

`firebase-config.local.mjs` holds the Firebase Web configuration supplied for
`fire-counsel`. Its path is in the repository `.gitignore`; the local config is
not committed. On another machine, copy `firebase-config.example.mjs` to
`firebase-config.local.mjs` and provide the Web API key locally.

`client.mjs` initializes the Firebase Web SDK. `auth-client.mjs` implements
email/password sign-in, Google popup sign-in with redirect fallback, sign-out,
Firebase password-reset emails, and Firebase ID-token headers for same-origin `/api/...` calls. `auth.html` is
the shared sign-in page; the admin page requests `/api/v1/admin/me` and treats
the backend response—not a browser claim—as authoritative. It does not grant
admin claims or enable live edits.

The provided config confirms the project ID, Auth domain, Storage bucket, app
ID and measurement ID. It does **not** verify the live project's Firestore
database ID/location, enabled providers, authorized domains, current deployed
rules, App Check state or existing admin claims. No Firebase settings were
changed remotely.

## Enable Google sign-in

The code is present, but Google sign-in will return `auth/operation-not-allowed`
until it is enabled in Firebase Console:

1. Open **Firebase Console → fire-counsel → Authentication → Sign-in method**.
2. Select **Google**, enable it, choose the support email, then save.
3. Under **Authentication → Settings → Authorized domains**, add the exact
   development and deployed web domains (for example `localhost` for local
   testing and the final HTTPS domain). Do not add broad wildcards.
4. Use `auth.html` and choose **Continue with Google**. The code uses popup sign-in
   and falls back to redirect when popups are blocked.
5. For an administrator, a trusted project owner must separately grant the
   Firebase Auth user the `admin: true` custom claim. Google sign-in or an email
   address alone never grants admin access.

Email/password sign-in uses the existing Firebase Auth provider the owner says is
enabled. This code does not create accounts. The UI can load only when the local
ignored Firebase config file exists. Auth pages use relative API paths; a
same-origin backend/proxy must provide `/api/v1/me` and `/api/v1/admin/me`.

The Web API key is public client configuration, not an admin credential. Restrict
it to approved APIs and website referrers in Google Cloud Console. Never put a
Firebase service-account key, Gemini secret, or other server credential in this
file.

## Local tests and deployment gate

From this directory, `npm run test:local` checks that the legacy IndexedDB name,
version, stores and session counter remain unchanged and that service-worker
cleanup does not clear browser study data. `npm run test:rules` runs the Firestore
and Storage suite against local emulators using a `demo-` project ID; it covers
anonymous/student/admin reads and writes, slide upload type/size, public reads,
and admin-only deletion. It never targets the live Firebase project.

The rules suite is prepared but has **not** passed in this workspace: the Firebase
Emulator Suite could not start because Java is not installed (`Could not spawn
java -version`). Do not deploy the proposed rules or enable Firebase Storage
uploads until `npm run test:rules` passes in a Java-enabled environment and the
active project's settings/current rules have been reviewed.
