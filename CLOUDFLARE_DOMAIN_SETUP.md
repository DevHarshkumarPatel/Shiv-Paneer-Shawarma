# Mapping `shivpaneershawarma.com` (Cloudflare DNS) to the Cloud Run services

This guide binds the live app to your custom domain. Follow the steps in order —
DNS + certificate first, then the two small app-config changes, then verify.

---

## 0. What you are binding, and why both services

The app is **two separate Cloud Run services**. The website (frontend) talks to the
API (backend) over the network, so **both** need a public hostname.

| Hostname | Cloud Run service | Region | What it is |
|---|---|---|---|
| `shivpaneershawarma.com` (apex/naked) | **`sps-frontend`** | `us-central1` | The customer + staff website (nginx) |
| `www.shivpaneershawarma.com` | **`sps-frontend`** | `us-central1` | Same site (we'll redirect `www` → apex) |
| `api.shivpaneershawarma.com` | **`sps-backend`** | `us-central1` | The FastAPI backend / API |

**Fixed values used throughout (from `.deploy/config.env`):**

| Setting | Value |
|---|---|
| GCP project id | `shivpaneershawarma` |
| Region | `us-central1` |
| Frontend service | `sps-frontend` |
| Backend service | `sps-backend` |

> **Why a separate `api.` subdomain?** The frontend and backend are different
> services with different URLs. Putting the API on `api.shivpaneershawarma.com`
> keeps it on the same registrable domain as the site (`shivpaneershawarma.com`),
> which keeps the staff login cookie working and CORS simple.

---

## 1. Prerequisites

- `gcloud` CLI installed and logged in as an account with the **Owner** or
  **Cloud Run Admin** + **Project IAM Admin** roles on the project.
- Access to the **Cloudflare dashboard** for `shivpaneershawarma.com` (the domain's
  nameservers already point to Cloudflare — since you manage DNS there, they do).
- The app already deployed once (`./deploy.sh`) so both services exist.

Confirm the services exist and note their current `*.run.app` URLs:

```bash
gcloud config set project shivpaneershawarma

gcloud run services list --region us-central1 \
  --format='table(SERVICE, URL)'
# Expect to see sps-frontend and sps-backend with https://...run.app URLs
```

---

## 2. Verify domain ownership with Google (one time)

Cloud Run will only map a domain your Google account has **verified**.

```bash
gcloud domains verify shivpaneershawarma.com
```

This opens **Google Search Console**. Choose **domain** verification; it gives you a
**TXT record**. Add it in Cloudflare:

1. Cloudflare → your domain → **DNS → Records → Add record**
2. **Type:** `TXT` · **Name:** `@` · **Content:** the `google-site-verification=…`
   string Search Console gave you · **TTL:** Auto
3. Save, wait ~2–5 min, then click **Verify** in Search Console.

> If you have verified this domain before with the same Google account, you can skip
> this step.

---

## 3. Create the Cloud Run domain mappings

Run these three commands (region matters — the mapping must be in the service's region).

> **Note:** for fully-managed Cloud Run these commands live under the **`beta`**
> group — use `gcloud beta run domain-mappings …` (plain `gcloud run domain-mappings`
> errors out). If gcloud says the beta component is missing, run
> `gcloud components install beta` once and re-run.

```bash
# Website → apex
gcloud beta run domain-mappings create \
  --service sps-frontend \
  --domain shivpaneershawarma.com \
  --region us-central1

# Website → www
gcloud beta run domain-mappings create \
  --service sps-frontend \
  --domain www.shivpaneershawarma.com \
  --region us-central1

# API → api subdomain
gcloud beta run domain-mappings create \
  --service sps-backend \
  --domain api.shivpaneershawarma.com \
  --region us-central1
```

Each command prints the **DNS records** you must add in Cloudflare. Re-print them any
time with:

```bash
gcloud beta run domain-mappings describe --domain shivpaneershawarma.com \
  --region us-central1 --format='value(status.resourceRecords)'
```

**What Google returns (typical):**

- **Apex `shivpaneershawarma.com`** → four **A** records + four **AAAA** records
  pointing at Google IPs. Typical values (verify against your `describe` output):

  | Type | Name | Value |
  |---|---|---|
  | A | `@` | `216.239.32.21` |
  | A | `@` | `216.239.34.21` |
  | A | `@` | `216.239.36.21` |
  | A | `@` | `216.239.38.21` |
  | AAAA | `@` | `2001:4860:4802:32::15` |
  | AAAA | `@` | `2001:4860:4802:34::15` |
  | AAAA | `@` | `2001:4860:4802:36::15` |
  | AAAA | `@` | `2001:4860:4802:38::15` |

- **`www`** → one **CNAME** → `ghs.googlehosted.com.`
- **`api`** → one **CNAME** → `ghs.googlehosted.com.`

> Always use the exact records from your own `describe`/create output. Google can
> change the apex IPs; the ones above are the common current set.

---

## 4. Add the DNS records in Cloudflare — **DNS only (grey cloud)**

In Cloudflare → **DNS → Records**, add everything from step 3. **Set every one of these
records to "DNS only" (grey cloud, NOT the orange proxied cloud).**

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | `216.239.32.21` | **DNS only** |
| A | `@` | `216.239.34.21` | **DNS only** |
| A | `@` | `216.239.36.21` | **DNS only** |
| A | `@` | `216.239.38.21` | **DNS only** |
| AAAA | `@` | `2001:4860:4802:32::15` | **DNS only** |
| AAAA | `@` | `2001:4860:4802:34::15` | **DNS only** |
| AAAA | `@` | `2001:4860:4802:36::15` | **DNS only** |
| AAAA | `@` | `2001:4860:4802:38::15` | **DNS only** |
| CNAME | `www` | `ghs.googlehosted.com` | **DNS only** |
| CNAME | `api` | `ghs.googlehosted.com` | **DNS only** |

> ### ⚠️ Why grey cloud (DNS only) matters
> Cloud Run provisions its **own** free SSL certificate for each mapped domain. For
> Google to validate and serve that cert, the hostname must resolve **directly** to
> Google. If you leave Cloudflare's **orange proxy on**, Cloudflare terminates TLS at
> its edge, Google can't complete cert issuance, the mapping stays stuck on
> `CertificatePending`, and you typically see a Cloudflare **`525`/`526`** or an
> infinite redirect. **Start with DNS only.** (You can move to proxied later — see
> the appendix — but get it working first.)

Remove any old/parked A or CNAME records on `@`, `www`, or `api` that point somewhere
else, or they'll conflict.

---

## 5. Cloudflare SSL/TLS setting

Cloudflare → **SSL/TLS → Overview** → set encryption mode to **Full (strict)**.

- With **DNS only** records this is effectively pass-through, but Full (strict) is the
  correct, safe setting and is required if you ever switch to proxied.
- **Do NOT use "Flexible"** — it causes redirect loops with Cloud Run (which always
  redirects HTTP→HTTPS).

---

## 6. Wait for the certificates, then confirm mappings are Ready

Google auto-issues the managed certs once DNS resolves (usually 15 min, can take up to
~1 hour). Check status:

```bash
for d in shivpaneershawarma.com www.shivpaneershawarma.com api.shivpaneershawarma.com; do
  echo "== $d =="
  gcloud beta run domain-mappings describe --domain "$d" --region us-central1 \
    --format='value(status.conditions)'
done
```

You want each to reach **`Ready: True`** (cert `CertificateProvisioned`). While it says
`CertificatePending`, keep waiting — do not toggle Cloudflare proxy on.

---

## 7. Point the app at the custom domains (two config changes)

Right now the frontend was built to call the backend's `*.run.app` URL, and the backend
only trusts the frontend's `*.run.app` origin. Update both to the custom domains.

### 7a. Frontend `API_BASE` → `https://api.shivpaneershawarma.com`

The frontend's `API_BASE` is **baked into the image** at deploy time by `deploy.sh`
(section 9, it overwrites `frontend/js/config.js`). So a plain redeploy would overwrite
any manual change. Make it durable by editing **`deploy.sh`**:

Find this block (~line 402):

```bash
window.SPS_CONFIG = {
  API_BASE: "$BACKEND_URL",
  CURRENCY: "₹",
  runtime: {},
};
```

Change `API_BASE` to prefer a custom URL when set:

```bash
window.SPS_CONFIG = {
  API_BASE: "${PUBLIC_API_URL:-$BACKEND_URL}",
  CURRENCY: "₹",
  runtime: {},
};
```

Then set the variable and redeploy the frontend:

```bash
export PUBLIC_API_URL="https://api.shivpaneershawarma.com"
./deploy.sh          # choose the "frontend only" option when prompted
```

> Prefer not to touch `deploy.sh`? Alternatively, keep `PUBLIC_API_URL` exported and
> redeploy — but the durable edit above means you never forget it.

### 7b. Backend `CORS_ORIGINS` → the site's custom origins

The browser will now send `Origin: https://shivpaneershawarma.com`, so the backend must
trust it. Update the backend env directly (takes effect immediately, no rebuild):

```bash
gcloud run services update sps-backend \
  --region us-central1 --project shivpaneershawarma \
  --update-env-vars '^@^CORS_ORIGINS=https://shivpaneershawarma.com,https://www.shivpaneershawarma.com'
```

> The `^@^` makes `@` the delimiter so the **comma stays inside the value**.

Make it durable too, so the next full `deploy.sh` doesn't reset it. In `deploy.sh`
section 11 (the CORS wiring), append the custom origins to `CORS_ORIGINS_VAL`, e.g.:

```bash
CORS_ORIGINS_VAL="$FRONTEND_URL"
[ -n "$PROJECT_NUMBER" ] && [ "$FRONTEND_URL_ALT" != "$FRONTEND_URL" ] \
  && CORS_ORIGINS_VAL="$FRONTEND_URL,$FRONTEND_URL_ALT"
# --- add the custom domains ---
CORS_ORIGINS_VAL="$CORS_ORIGINS_VAL,https://shivpaneershawarma.com,https://www.shivpaneershawarma.com"
```

> **Cookies/login note:** the staff cookie is issued `SameSite=None; Secure`, which
> works both cross-site (today's `*.run.app`) and across `shivpaneershawarma.com` ↔
> `api.shivpaneershawarma.com`. No cookie change is required. (Because both are now on
> the same registrable domain, you *could* later simplify to `SameSite=Lax`, but it's
> optional.)

---

## 8. Redirect `www` → apex (optional but recommended)

So `www.shivpaneershawarma.com` sends people to the canonical `shivpaneershawarma.com`:

Cloudflare → **Rules → Redirect Rules → Create rule**
- **When:** Hostname equals `www.shivpaneershawarma.com`
- **Then:** Static redirect → `https://shivpaneershawarma.com` + preserve path/query,
  status **301**.

(The `www` domain mapping from step 3 still needs to exist so Cloudflare has a valid
record to attach the rule to; the redirect runs before the origin.)

---

## 9. Verify everything

```bash
# 1) DNS resolves to Google (grey cloud) — expect 216.239.x.x / ghs.googlehosted.com
dig +short shivpaneershawarma.com
dig +short api.shivpaneershawarma.com

# 2) API is reachable on the custom domain
curl -s https://api.shivpaneershawarma.com/health
# -> {"status":"ok","app":"Shiv Paneer Shawarma","env":"production"}

# 3) Website loads
curl -sI https://shivpaneershawarma.com | head -n1
# -> HTTP/2 200
```

Then in a **browser**:
1. Open `https://shivpaneershawarma.com` — the menu should load (proves the site can
   reach `api.shivpaneershawarma.com`; if the menu is empty, it's usually CORS — see
   troubleshooting).
2. Place a test order end-to-end.
3. Open `https://shivpaneershawarma.com/staff/login.html`, log in as owner, confirm the
   orders board loads (proves the cross-subdomain auth cookie works).

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cloudflare **525 / 526** or redirect loop | Cloudflare proxy (orange) on, or SSL = Flexible | Set records to **DNS only (grey)**, SSL = **Full (strict)** |
| Mapping stuck `CertificatePending` for >1h | DNS not resolving to Google (proxied, or wrong/missing records) | Grey-cloud the records; re-check `dig`; wait |
| Menu empty / console shows **CORS error** | `CORS_ORIGINS` missing the site origin | Re-run step **7b** with the exact origin from the browser error |
| Staff **login fails / immediately logged out** | Cookie blocked | Confirm both hosts are HTTPS and on `shivpaneershawarma.com`; backend cookie is `Secure; SameSite=None`; `credentials:'include'` is already set |
| `curl https://api…/health` fails but `*.run.app/health` works | `api` mapping/DNS not ready | Check step 6 status; verify the `api` CNAME → `ghs.googlehosted.com` |
| Site loads but calls still hit `*.run.app` | Frontend image still has old `API_BASE` | Redo step **7a** and redeploy the **frontend** |

---

## Appendix A — Switching Cloudflare to Proxied (orange cloud) later

Once the Cloud Run certs are **Ready** and the site works on DNS-only, you *may* enable
Cloudflare's proxy for CDN/DDoS/WAF:

1. Keep **SSL/TLS = Full (strict)**.
2. Flip the `@`, `www`, and `api` records to **Proxied (orange)**.
3. Cloudflare now serves its own edge cert to visitors and connects to Google over
   HTTPS. The Cloud Run managed cert stays valid on the origin side.
4. Re-test all of step 9. If you get 5xx/redirect loops, revert to DNS-only.

> Trade-off: proxied hides your origin and adds caching/WAF, but adds a moving part in
> front of Cloud Run. For a small site, **DNS-only is perfectly fine** and simplest.

## Appendix B — Alternative: Global External Load Balancer

For higher scale or if domain mappings aren't available in a future region, put a
**Global External Application Load Balancer** with a **Serverless NEG** in front of each
Cloud Run service and point Cloudflare at the LB's IP. More setup and cost; **not needed**
for this project today — domain mappings are the right call.

## Appendix C — Google Maps key (later)

When you add a real `MAPS_API_KEY`, restrict it in Google Cloud console to the
**HTTP referrers**: `https://shivpaneershawarma.com/*` and
`https://www.shivpaneershawarma.com/*`.
