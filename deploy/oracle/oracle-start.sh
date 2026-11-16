#!/bin/bash
# =====================================================================
#  FIRE COUNSEL — paste this whole file into Oracle Cloud when creating
#  the server:  Create instance → Show advanced options → Management →
#  "Paste cloud-init script".
#
#  Fill in the 4 lines in BOX 1 and paste your Firebase key file in BOX 2.
#  Do NOT change anything else. Do NOT save the filled-in copy on GitHub.
# =====================================================================

cat > /root/fire-counsel.secrets <<'FIRE_COUNSEL_SETTINGS'
# ---------------- BOX 1: type after the = sign, no spaces ----------------
ADMIN_EMAILS=
DATABASE_URL=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
# -------------------------------------------------------------------------
FIRE_COUNSEL_SETTINGS

cat > /root/firebase-service-account.json <<'FIRE_COUNSEL_FIREBASE_KEY'
PASTE THE WHOLE FIREBASE KEY FILE HERE (replace this line, keep the lines above and below)
FIRE_COUNSEL_FIREBASE_KEY

chmod 600 /root/fire-counsel.secrets /root/firebase-service-account.json

# Download and run the setup (takes about 5–10 minutes).
for attempt in 1 2 3 4 5; do
  curl -fsSL https://raw.githubusercontent.com/VICTORIOUS-TECH-001/Fire-counsel-/main/deploy/oracle/setup.sh -o /root/fire-counsel-setup.sh && break
  sleep 15
done
bash /root/fire-counsel-setup.sh > /var/log/fire-counsel-setup.log 2>&1
