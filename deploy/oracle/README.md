# FIRE COUNSEL on Oracle Cloud (Always Free)

One free server runs the whole site (website, AI and admin) with **no sleeping**.
Free size (2026): **2 CPU cores, 12 GB memory, 200 GB disk, 10 TB traffic/month**.
Cost: **$0**. Oracle needs a real debit/credit card only to check who you are.

## Before you start (have these ready)

1. Your **Neon connection string** (Neon → your project → **Connect** → copy).
2. At least one **writer key**: [Groq](https://console.groq.com/keys) (preferred for text), [Gemini](https://aistudio.google.com/apikey) or [OpenRouter](https://openrouter.ai/keys).
3. For online retrieval: [Tavily](https://app.tavily.com) and/or [Brave Search API](https://api-dashboard.search.brave.com). Both enable independent failover. API access/quota/cost are separate from the hosting plan; Groq alone does not search the web.
4. Your **Firebase key file**: https://console.firebase.google.com/project/fire-counsel/settings/serviceaccounts/adminsdk → **Generate new private key** (sign in with the Google account that owns `fire-counsel`).
5. The start script: https://raw.githubusercontent.com/VICTORIOUS-TECH-001/Fire-counsel-/main/deploy/oracle/oracle-start.sh

## Step 1: Create the Oracle account

1. Open https://signup.oraclecloud.com
2. **Home region:** choose **US Midwest (Chicago)**. It is close to the Neon database (Ohio). **This cannot be changed later.**
3. Finish the card check (a small temporary hold, not a charge).

*Recommended:* **Billing → Upgrade to Pay As You Go.** Oracle does not charge for Always Free resources after upgrading. It makes free servers easier to get and much less likely to be taken back when quiet. Then set **Billing → Budgets → Create budget → $1** so you get an email if anything ever costs money.

## Step 2: Fill in the start script

Copy the start script (link 5 above) into a notes app:

- After `ADMIN_EMAILS=`, type your email.
- After `DATABASE_URL=`, paste the Neon connection string.
- Fill at least one writer line: `GROQ_API_KEY=`, `GEMINI_API_KEY=` or `OPENROUTER_API_KEY=`. Leave unused providers empty. Groq keys are not xAI/Grok keys.
- Fill `TAVILY_API_KEY=` and, for failover, `BRAVE_SEARCH_API_KEY=`. Groq + Tavily/Brave works without Gemini for text. Installing Brave's browser does not supply API access.
- The template prefers `AI_WRITER_PROVIDER_ORDER=groq,gemini,openrouter` and `WEB_SEARCH_PROVIDER_ORDER=tavily,brave,gemini`. Orders only set priority; unset-key providers are skipped and omitted defaults are appended. Research reuse is off (`AI_RESEARCH_CACHE_MINUTES=0`).
- `make-env.mjs` accepts/preserves these settings on reruns and reports a missing **writer key**, not a mandatory Gemini key. Optional model/timeout/token overrides are also supported; choose values permitted by the actual provider account. These Groq models cannot read photos/PDFs; OCR remains separate.
- Replace the line `PASTE THE WHOLE FIREBASE KEY FILE HERE…` with the **whole** Firebase key file (from `{` to `}`).

Do not change anything else, and never put the filled-in copy on GitHub.

## Step 3: Create the server

Open https://cloud.oracle.com/compute/instances/create

1. **Name:** `fire-counsel`
2. **Image:** **Change image → Ubuntu → Canonical Ubuntu 24.04** → Select.
3. **Shape:** **Change shape → Ampere → VM.Standard.A1.Flex**, set **2 OCPUs** and **12 GB** memory → Select.
   If it says **Out of capacity**, try 1 OCPU / 6 GB, try again later, or choose another availability domain.
4. **Networking:** keep "Create new virtual cloud network" and **Assign a public IPv4 address: Yes**.
5. **SSH keys:** **Generate a key pair for me** → **Save private key** (keep it safe; it is needed only to change settings later).
6. **Show advanced options → Management → Paste cloud-init script** → paste your filled-in start script.
7. Press **Create**.

## Step 4: Open the web ports

1. On the server page, under **Primary VNIC**, tap the **Subnet** link.
2. **Security** (or **Security Lists**) → **Default Security List** → **Add Ingress Rules**.
3. Source CIDR `0.0.0.0/0`, IP protocol **TCP**, Destination port range `80,443` → **Add Ingress Rules**.

## Step 5: Open your site (after about 10 minutes)

1. Copy the server's **Public IP address**, for example `129.1.2.3`.
2. Your site address is the IP with dashes + `.sslip.io`:
   **https://129-1-2-3.sslip.io**
3. Check: **https://129-1-2-3.sslip.io/api/health** should show `"database":"connected"`.

## Step 6: Allow sign-in on the new address

https://console.firebase.google.com/project/fire-counsel/authentication/settings → **Authorized domains → Add domain** → `129-1-2-3.sslip.io` (your own).

The health response should include `config_diagnostics_version: 2` after installing this repair. `setup.groq_key`, `setup.tavily_key` and `setup.brave_search_key` only report credential **presence**. Sign in as the Google administrator → **AI studio settings → Test AI connection**, with web search selected, to check real API authentication/quota and returned sources (this spends provider quota). See [the full search deployment/error guide](../../DEPLOYMENT.md#5-groqtavily-still-show-false-after-saving-keys). This repair requires no new migration, but existing AI tables are still needed.

Then: run the Neon AI tables workflow once (https://github.com/VICTORIOUS-TECH-001/Fire-counsel-/actions/workflows/neon-migrate.yml → **Run workflow**), open `https://…sslip.io/admin.html`, sign in, tap **Make this account the administrator**, and upload your prompts.

## Updates

Anything merged into `main` on GitHub is installed automatically within about 10 minutes. If a new version fails to start, the server puts the previous version back.

## Changing a setting later

Oracle console → top bar **Cloud Shell** (`>_`) → upload your private key → run:

```
chmod 600 ssh-key-*.key
ssh -i ssh-key-*.key ubuntu@YOUR_IP
sudo nano /etc/fire-counsel/app.env       # edit, then Ctrl+O, Enter, Ctrl+X
sudo systemctl restart fire-counsel
```

Useful: `cat /root/FIRE-COUNSEL-STATUS.txt` (setup result), `sudo tail -50 /var/log/fire-counsel-setup.log` (setup log), `journalctl -u fire-counsel -f` (live server log).

## Using your own domain later

Point the domain's **A record** to the server IP, add `FC_DOMAIN=study.yourdomain.com` to `/etc/fire-counsel/app.env` as `FC_DOMAIN='study.yourdomain.com'`, then run `sudo bash /opt/fire-counsel/deploy/oracle/setup.sh` and add the domain in Firebase **Authorized domains**.
