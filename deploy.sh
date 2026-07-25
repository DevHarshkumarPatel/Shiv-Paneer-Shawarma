#!/usr/bin/env bash
# =============================================================================
#  Shiv Paneer Shawarma — Google Cloud Run deployment
# =============================================================================
#  Deploys the FastAPI backend and the static frontend as two Cloud Run
#  services in us-central1, wires them together, and (optionally) creates the
#  Datastore-mode database and seeds it.
#
#  It is INTERACTIVE and SAFE by design:
#    - it prints exactly what it will do and asks before every billable /
#      irreversible step (enabling APIs, creating the database, deploying);
#    - it never touches your source tree — all build artifacts go under
#      ./.deploy/ (git-ignored);
#    - secrets are generated once and cached in ./.deploy/secrets.env so
#      re-running the script does NOT log every staff member out.
#
#  Requirements: gcloud SDK (authenticated), python3. No local Docker needed —
#  images are built by Cloud Build.
#
#  Usage:  ./deploy.sh
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
#  Fixed choices
# ---------------------------------------------------------------------------
REGION="us-central1"          # requested deploy region (do not change casually)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$ROOT/.deploy"
SECRETS_FILE="$BUILD/secrets.env"
CONFIG_FILE="$BUILD/config.env"     # remembered (non-secret) answers

# ---------------------------------------------------------------------------
#  Pretty output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; BLU=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; BLU=""; RST=""
fi
say()  { printf '%s\n' "$*"; }
section() { printf '\n%s──%s %s%s\n' "$BLU" "$RST" "$BOLD$*$RST" ""; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$RST" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# ask VAR "Prompt" "default"
ask() {
  local __var="$1" __prompt="$2" __def="${3:-}" __ans
  if [ -n "$__def" ]; then
    read -r -p "$__prompt [$__def]: " __ans || true
    __ans="${__ans:-$__def}"
  else
    read -r -p "$__prompt: " __ans || true
  fi
  printf -v "$__var" '%s' "$__ans"
}

# ask_secret VAR "Prompt"  (input hidden)
ask_secret() {
  local __var="$1" __prompt="$2" __ans
  read -r -s -p "$__prompt: " __ans || true
  echo
  printf -v "$__var" '%s' "$__ans"
}

# confirm "Question"  -> returns 0 on yes
confirm() {
  local __ans
  read -r -p "$* ${DIM}[y/N]${RST} " __ans || true
  [[ "$__ans" =~ ^[Yy]$ ]]
}

# YAML-escape a value for the --env-vars-file (double-quoted scalar).
yq() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# ---------------------------------------------------------------------------
#  0. Pre-flight
# ---------------------------------------------------------------------------
section "Pre-flight checks"
command -v gcloud >/dev/null 2>&1 || die "gcloud SDK not found. Install it first."
command -v python3 >/dev/null 2>&1 || die "python3 not found (needed to generate secrets)."

ACTIVE_ACCT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
[ -n "$ACTIVE_ACCT" ] || die "Not logged in. Run: gcloud auth login"
ok "gcloud authenticated as ${BOLD}$ACTIVE_ACCT${RST}"

GCLOUD_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"

# ---------------------------------------------------------------------------
#  1. Gather configuration (interactive)
# ---------------------------------------------------------------------------
mkdir -p "$BUILD"

# Load previously-saved (non-secret) answers, if any, to use as defaults.
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# The project lives under a different Google account than the machine's global
# gcloud default. Rather than force `gcloud config set account` (which would
# change the default for every other project on this machine), we pin the
# account for THIS script only via CLOUDSDK_CORE_ACCOUNT — an env override that
# every gcloud call below inherits, leaving the global default untouched.
DEPLOY_ACCOUNT="${DEPLOY_ACCOUNT:-wings.animations8279@gmail.com}"
if [ -n "$DEPLOY_ACCOUNT" ]; then
  export CLOUDSDK_CORE_ACCOUNT="$DEPLOY_ACCOUNT"
  if ! gcloud auth list --format='value(account)' 2>/dev/null | grep -qxF "$DEPLOY_ACCOUNT"; then
    warn "Deploy account '$DEPLOY_ACCOUNT' is not authenticated on this machine yet."
    say  "${DIM}A browser window will open to sign in. This does NOT change your"
    say  "global default gcloud account — it only adds credentials.${RST}"
    if confirm "Log in as '$DEPLOY_ACCOUNT' now?"; then
      gcloud auth login "$DEPLOY_ACCOUNT" \
        || die "Login failed for '$DEPLOY_ACCOUNT'. Cannot continue."
    else
      die "Cannot deploy without an authenticated '$DEPLOY_ACCOUNT'. Aborting."
    fi
    gcloud auth list --format='value(account)' 2>/dev/null | grep -qxF "$DEPLOY_ACCOUNT" \
      || die "Still not authenticated as '$DEPLOY_ACCOUNT' after login. Aborting."
  fi
  ACTIVE_ACCT="$DEPLOY_ACCOUNT"
  ok "Deploying as ${BOLD}$DEPLOY_ACCOUNT${RST} ${DIM}(global gcloud default left unchanged)${RST}"
fi

# Fast path: if we have a saved config, offer to reuse it verbatim.
REUSE=no
if [ -n "${PROJECT:-}" ]; then
  section "Saved configuration found (.deploy/config.env)"
  cat <<EOF
  Account   : $DEPLOY_ACCOUNT
  Project   : $PROJECT
  Services  : $BACKEND_SVC (backend) / $FRONTEND_SVC (frontend)
  Database  : $DB_NAME @ $DB_LOCATION
  UPI       : $UPI_VPA ($UPI_PAYEE_NAME)   Delivery fee ₹$DELIVERY_FEE
EOF
  confirm "Reuse these saved settings (answer n to re-enter everything)?" && REUSE=yes
fi

if [ "$REUSE" != yes ]; then
  section "Configuration"
  warn "The current gcloud project is: ${BOLD}${GCLOUD_PROJECT:-<none>}${RST}"
  say  "${DIM}Everything below is created inside the project you name here.${RST}"
  ask PROJECT "Target Google Cloud project id" "${PROJECT:-${GCLOUD_PROJECT:-shiv-paneer-shawarma}}"
  [ -n "$PROJECT" ] || die "A project id is required."

  ask BACKEND_SVC  "Backend Cloud Run service name"  "${BACKEND_SVC:-sps-backend}"
  ask FRONTEND_SVC "Frontend Cloud Run service name" "${FRONTEND_SVC:-sps-frontend}"

  # Named Datastore database (this project uses a non-default database).
  ask DB_NAME "Datastore database id" "${DB_NAME:-spsndb}"
  [ -n "$DB_NAME" ] || die "A database id is required."
  # Firestore/Datastore location. us-central1 is a valid regional location.
  ask DB_LOCATION "Datastore database location (regional or multi-region like nam5)" "${DB_LOCATION:-$REGION}"

  section "Restaurant / app settings"
  ask UPI_VPA        "UPI VPA (where customers pay)"        "${UPI_VPA:-9429271514-2@okbizaxis}"
  ask UPI_PAYEE_NAME "UPI payee display name"               "${UPI_PAYEE_NAME:-Shiv Paneer Shawarma}"
  ask DELIVERY_FEE   "Default delivery fee (INR)"           "${DELIVERY_FEE:-40}"
  ask MAPS_API_KEY   "Google Maps API key (blank to skip)"  "${MAPS_API_KEY:-}"
fi

# Custom domain(s) the site is served from, if any. Comma-separated, full
# https:// origins (e.g. "https://shivpaneershawarma.com,https://www.shivpaneershawarma.com").
# These are ADDED to CORS_ORIGINS so the browser at the custom domain is allowed
# to call the backend. Blank => only the *.run.app origins are used.
# Asked ALWAYS (even when reusing saved settings) because CORS breaks the site
# the moment the domain changes, and it changes more often than the rest.
section "Custom domain / CORS"
ask CUSTOM_DOMAINS "Custom frontend domain origin(s), comma-separated (blank=none)" "${CUSTOM_DOMAINS:-}"

# --- Derived + validation (always run, reused or not) ---
[ "$MAPS_API_KEY" = "YOUR_GOOGLE_MAPS_API_KEY" ] && MAPS_API_KEY=""
[ -n "$MAPS_API_KEY" ] || MAPS_API_KEY="YOUR_GOOGLE_MAPS_API_KEY"
RUN_SA_ID="sps-run"
RUN_SA="${RUN_SA_ID}@${PROJECT}.iam.gserviceaccount.com"

# Verify the project exists and is reachable for this account.
gcloud projects describe "$PROJECT" >/dev/null 2>&1 \
  || die "Project '$PROJECT' not found or not accessible by $ACTIVE_ACCT."
ok "Project '$PROJECT' is reachable."

# Persist the non-secret answers for next time.
cat > "$CONFIG_FILE" <<EOF
# Saved by deploy.sh — non-secret answers reused on the next run. Safe to edit.
DEPLOY_ACCOUNT='$DEPLOY_ACCOUNT'
PROJECT='$PROJECT'
BACKEND_SVC='$BACKEND_SVC'
FRONTEND_SVC='$FRONTEND_SVC'
CUSTOM_DOMAINS='${CUSTOM_DOMAINS:-}'
DB_NAME='$DB_NAME'
DB_LOCATION='$DB_LOCATION'
UPI_VPA='$UPI_VPA'
UPI_PAYEE_NAME='$UPI_PAYEE_NAME'
DELIVERY_FEE='$DELIVERY_FEE'
MAPS_API_KEY='$MAPS_API_KEY'
EOF
ok "Settings saved to ${DIM}.deploy/config.env${RST}"

# ---------------------------------------------------------------------------
#  1b. What to deploy
# ---------------------------------------------------------------------------
section "What do you want to deploy?"
say "  1) Both        — backend + frontend"
say "  2) Backend only"
say "  3) Frontend only"
ask DEPLOY_CHOICE "Choose 1/2/3" "1"
case "$DEPLOY_CHOICE" in
  2) DO_BACKEND=yes; DO_FRONTEND=no;  TARGET_LABEL="backend only" ;;
  3) DO_BACKEND=no;  DO_FRONTEND=yes; TARGET_LABEL="frontend only" ;;
  *) DO_BACKEND=yes; DO_FRONTEND=yes; TARGET_LABEL="backend + frontend" ;;
esac
ok "Target: ${BOLD}$TARGET_LABEL${RST}"

# ---------------------------------------------------------------------------
#  2. Secrets (generate once, reuse on re-runs) — only needed for the backend
# ---------------------------------------------------------------------------
if [ "$DO_BACKEND" = yes ]; then
  section "Secrets"
  if [ -f "$SECRETS_FILE" ]; then
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
    ok "Reusing existing secrets from .deploy/secrets.env (sessions stay valid)."
  fi
  if [ -z "${JWT_SECRET:-}" ]; then
    JWT_SECRET="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
    ok "Generated a new JWT_SECRET."
  fi
  if [ -z "${SETUP_KEY:-}" ]; then
    SETUP_KEY="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
    ok "Generated a new SETUP_KEY (gates the user-provisioning page)."
  fi
  # NB: set perms on the file itself — do NOT `umask 077` here, or it leaks into
  # the build-context file copies below and nginx (non-root) can't read them (403).
  cat > "$SECRETS_FILE" <<EOF
# Generated by deploy.sh — DO NOT COMMIT. Deleting this rotates the secrets
# on the next deploy (which logs everyone out and invalidates the setup key).
JWT_SECRET='$JWT_SECRET'
SETUP_KEY='$SETUP_KEY'
EOF
  chmod 600 "$SECRETS_FILE"
  ok "Secrets cached in ${DIM}.deploy/secrets.env${RST} (chmod 600)."
fi

# ---------------------------------------------------------------------------
#  3. Summary + confirmation
# ---------------------------------------------------------------------------
section "Review — nothing has been changed yet"
cat <<EOF
  Account          : $ACTIVE_ACCT
  Project          : ${BOLD}$PROJECT${RST}
  Region           : $REGION
  Deploy target    : ${BOLD}$TARGET_LABEL${RST}
  Backend service  : $BACKEND_SVC   $([ "$DO_BACKEND" = yes ] && echo "(will deploy)" || echo "(unchanged)")
  Frontend service : $FRONTEND_SVC  $([ "$DO_FRONTEND" = yes ] && echo "(will deploy)" || echo "(unchanged)")
  Custom domain(s) : ${CUSTOM_DOMAINS:-(none — only *.run.app origins allowed)}
EOF
if [ "$DO_BACKEND" = yes ]; then
  cat <<EOF
  Runtime identity : $RUN_SA  (+ roles/datastore.user)
  Database         : ${BOLD}$DB_NAME${RST} — Firestore in Datastore mode @ $DB_LOCATION
  UPI              : $UPI_VPA  ($UPI_PAYEE_NAME)
  Delivery fee     : ₹$DELIVERY_FEE
  Maps key         : $([ "$MAPS_API_KEY" = "YOUR_GOOGLE_MAPS_API_KEY" ] && echo "(not set — graceful fallback)" || echo "(provided)")
EOF
fi
say ""
say "  ${DIM}Builds run on Cloud Build; Cloud Build, Artifact Registry storage and"
say "  Cloud Run all incur cost. Services update in place (no downtime).${RST}"
confirm "Proceed?" || { warn "Aborted. No changes made."; exit 0; }

gcloud config set project "$PROJECT" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
#  4. Enable required APIs
# ---------------------------------------------------------------------------
section "Enabling required APIs"
APIS="run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com"
# Datastore/Firestore APIs are only needed when the backend is involved.
[ "$DO_BACKEND" = yes ] && APIS="$APIS datastore.googleapis.com firestore.googleapis.com"
# shellcheck disable=SC2086
gcloud services enable $APIS --project "$PROJECT"
ok "APIs enabled."

# Steps 5 & 6 (database + runtime identity) only matter for the backend.
if [ "$DO_BACKEND" = yes ]; then
# ---------------------------------------------------------------------------
#  5. Datastore-mode database
# ---------------------------------------------------------------------------
section "Datastore database ($DB_NAME)"
DB_TYPE="$(gcloud firestore databases describe --database="$DB_NAME" \
            --project "$PROJECT" --format='value(type)' 2>/dev/null || true)"
if [ -z "$DB_TYPE" ]; then
  warn "No database named '$DB_NAME' exists in this project yet."
  say  "${DIM}A Firestore database's mode & location are permanent once created.${RST}"
  if confirm "Create database '$DB_NAME' in Datastore mode @ $DB_LOCATION?"; then
    gcloud firestore databases create \
      --database="$DB_NAME" --location="$DB_LOCATION" \
      --type=datastore-mode --project "$PROJECT"
    ok "Datastore-mode database '$DB_NAME' created."
  else
    die "Cannot continue without the database. Aborting."
  fi
elif [ "$DB_TYPE" = "DATASTORE_MODE" ]; then
  ok "Existing database '$DB_NAME' is in Datastore mode. Good."
else
  warn "Database '$DB_NAME' is '$DB_TYPE', NOT Datastore mode."
  die  "google-cloud-ndb needs Datastore mode. Recreate '$DB_NAME' as a
        Datastore-mode database, or use a different one."
fi

# ---------------------------------------------------------------------------
#  6. Runtime service account (least-privilege, Datastore only)
# ---------------------------------------------------------------------------
section "Runtime service account"
if gcloud iam service-accounts describe "$RUN_SA" --project "$PROJECT" >/dev/null 2>&1; then
  ok "Service account $RUN_SA already exists."
else
  gcloud iam service-accounts create "$RUN_SA_ID" \
    --project "$PROJECT" \
    --display-name "SPS Cloud Run runtime"
  ok "Created $RUN_SA."
fi
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$RUN_SA" \
  --role roles/datastore.user \
  --condition=None >/dev/null
ok "Granted roles/datastore.user to the runtime service account."
fi   # end DO_BACKEND (db + service account)

if [ "$DO_BACKEND" = yes ]; then
# ---------------------------------------------------------------------------
#  7. Build context: backend
# ---------------------------------------------------------------------------
section "Preparing backend build context"
rm -rf "$BUILD/backend"
mkdir -p "$BUILD/backend"
cp -r "$ROOT/backend/app"            "$BUILD/backend/app"
cp    "$ROOT/backend/requirements.txt" "$BUILD/backend/requirements.txt"
cp    "$ROOT/backend/seed.py"        "$BUILD/backend/seed.py"
# strip any copied bytecode
find "$BUILD/backend" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

cat > "$BUILD/backend/Dockerfile" <<'DOCKER'
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY seed.py .
# Cloud Run provides $PORT (defaults to 8080). Bind 0.0.0.0.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
DOCKER

cat > "$BUILD/backend/.gcloudignore" <<'IGN'
.venv/
__pycache__/
*.pyc
.env
IGN
ok "Backend context ready at .deploy/backend"

# Backend env file (production). CORS is filled in AFTER the frontend deploys.
write_backend_env() {
  local cors="$1"
  cat > "$BUILD/backend.env.yaml" <<EOF
APP_NAME: "$(yq "Shiv Paneer Shawarma")"
ENVIRONMENT: "production"
CORS_ORIGINS: "$(yq "$cors")"
GCP_PROJECT_ID: "$(yq "$PROJECT")"
DATASTORE_DATABASE: "$(yq "$DB_NAME")"
DATASTORE_EMULATOR_HOST: ""
JWT_SECRET: "$(yq "$JWT_SECRET")"
JWT_ALGORITHM: "HS256"
JWT_EXPIRE_MINUTES: "720"
COOKIE_NAME: "sps_token"
COOKIE_SECURE: "true"
COOKIE_SAMESITE: "none"
SETUP_KEY: "$(yq "$SETUP_KEY")"
DELIVERY_FEE: "$(yq "$DELIVERY_FEE")"
UPI_VPA: "$(yq "$UPI_VPA")"
UPI_PAYEE_NAME: "$(yq "$UPI_PAYEE_NAME")"
UPI_PAYEE_VPA_NAME: "$(yq "${UPI_PAYEE_VPA_NAME:-VIRALKUMAR}")"
UPI_MERCHANT_CODE: "$(yq "${UPI_MERCHANT_CODE:-5812}")"
UPI_MERCHANT_AID: "$(yq "${UPI_MERCHANT_AID:-uGICAgMDS4_a_XQ}")"
UPI_QR_VER: "$(yq "${UPI_QR_VER:-01}")"
UPI_QR_MODE: "$(yq "${UPI_QR_MODE:-01}")"
UPI_TXN_REF: "$(yq "${UPI_TXN_REF:-BCR2DN4T5LE5JELG}")"
MAPS_API_KEY: "$(yq "$MAPS_API_KEY")"
EOF
}

# ---------------------------------------------------------------------------
#  8. Deploy backend (CORS set to a placeholder for now)
# ---------------------------------------------------------------------------
section "Deploying backend  →  $BACKEND_SVC"
say "${DIM}Frontend<->backend live on different *.run.app hosts, so the session${RST}"
say "${DIM}cookie is issued SameSite=None; Secure so it survives cross-site.${RST}"
write_backend_env "https://placeholder.invalid"
gcloud run deploy "$BACKEND_SVC" \
  --source "$BUILD/backend" \
  --region "$REGION" \
  --project "$PROJECT" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --env-vars-file "$BUILD/backend.env.yaml" \
  --port 8080 \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 4
BACKEND_URL="$(gcloud run services describe "$BACKEND_SVC" \
  --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
[ -n "$BACKEND_URL" ] || die "Could not read backend URL after deploy."
ok "Backend live at ${BOLD}$BACKEND_URL${RST}"
else
  # Not deploying the backend — look up its existing URL (needed by the
  # frontend build to point API_BASE at it).
  BACKEND_URL="$(gcloud run services describe "$BACKEND_SVC" \
    --region "$REGION" --project "$PROJECT" --format='value(status.url)' 2>/dev/null || true)"
  if [ -n "$BACKEND_URL" ]; then
    ok "Using existing backend at ${BOLD}$BACKEND_URL${RST}"
  else
    warn "No existing backend service '$BACKEND_SVC' found in $REGION."
  fi
fi   # end DO_BACKEND (build + deploy)

if [ "$DO_FRONTEND" = yes ]; then
[ -n "$BACKEND_URL" ] || die "Frontend needs a backend URL, but '$BACKEND_SVC' is not deployed. Deploy the backend first (choose 1 or 2)."
# ---------------------------------------------------------------------------
#  9. Build context: frontend (inject backend URL into config.js)
# ---------------------------------------------------------------------------
section "Preparing frontend build context"
rm -rf "$BUILD/frontend"
mkdir -p "$BUILD/frontend/site"
cp -r "$ROOT/frontend/." "$BUILD/frontend/site/"
# Remove any dev-only cruft that may have been copied.
rm -rf "$BUILD/frontend/site/.git" 2>/dev/null || true

# Inject the Cloud Run backend URL as the *.run.app fallback. config.js keeps
# its own logic (on a custom domain it targets api.<domain>), so the file is
# patched, never overwritten — a new domain needs no change here.
CFG="$BUILD/frontend/site/js/config.js"
sed -i "s|^window.SPS_BACKEND_URL = \"\";|window.SPS_BACKEND_URL = \"$BACKEND_URL\";|" "$CFG"
grep -q "window.SPS_BACKEND_URL = \"$BACKEND_URL\";" "$CFG" \
  || die "Could not inject the backend URL into frontend/js/config.js — is the 'window.SPS_BACKEND_URL = \"\";' line still there?"
ok "Frontend *.run.app fallback set to $BACKEND_URL (custom domains use api.<domain>)"

cat > "$BUILD/frontend/nginx.conf" <<'NGINX'
server {
    listen       8080;
    server_name  _;
    root   /usr/share/nginx/html;
    index  index.html;

    # No client-side router: serve files as-is, 404 when missing.
    location / {
        try_files $uri $uri/ =404;
    }
    # Asset filenames are NOT content-hashed, so whatever is cached hard here
    # stays pinned in browsers until it expires. Split by how often each type
    # actually changes.

    # HTML/CSS/JS change on most deploys => revalidate on every load. A 304 is
    # a few hundred bytes, whereas a stale stylesheet is a visibly broken site
    # for the whole cache lifetime. ("expires 1h" on /assets/ used to do
    # exactly that: CSS edits took up to an hour to show up.)
    location ~* \.(html|css|js)$ {
        add_header Cache-Control "no-cache";
    }

    # Media is heavy and rarely edited => cache hard. To push a replacement out
    # before 30d, rename the file and update the reference in the HTML.
    location ~* \.(jpe?g|png|gif|svg|webp|ico|mp3|mp4|webm)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
}
NGINX

cat > "$BUILD/frontend/Dockerfile" <<'DOCKER'
FROM nginx:alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/site.conf
COPY site /usr/share/nginx/html
# Force world-readable perms so the non-root nginx worker can serve every file
# regardless of the host umask that created the build context (else -> 403).
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 8080
DOCKER
ok "Frontend context ready at .deploy/frontend"

# ---------------------------------------------------------------------------
# 10. Deploy frontend
# ---------------------------------------------------------------------------
section "Deploying frontend  →  $FRONTEND_SVC"
gcloud run deploy "$FRONTEND_SVC" \
  --source "$BUILD/frontend" \
  --region "$REGION" \
  --project "$PROJECT" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 256Mi --min-instances 0 --max-instances 4
FRONTEND_URL="$(gcloud run services describe "$FRONTEND_SVC" \
  --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
[ -n "$FRONTEND_URL" ] || die "Could not read frontend URL after deploy."
ok "Frontend live at ${BOLD}$FRONTEND_URL${RST}"
else
  # Not deploying the frontend — look up its existing URL for CORS wiring.
  FRONTEND_URL="$(gcloud run services describe "$FRONTEND_SVC" \
    --region "$REGION" --project "$PROJECT" --format='value(status.url)' 2>/dev/null || true)"
fi   # end DO_FRONTEND

# ---------------------------------------------------------------------------
# 11. Point backend CORS at the frontend origin(s)
# ---------------------------------------------------------------------------
# Cloud Run exposes TWO URL formats per service:
#   old : https://SERVICE-<hash>-<regioncode>.a.run.app   (== status.url)
#   new : https://SERVICE-<projectnumber>.<region>.run.app
# The browser's Origin is whichever one the user opens, so the backend must
# allow BOTH or CORS fails. Re-apply whenever we know a backend AND a frontend
# URL — this also repairs the placeholder a backend-only redeploy just wrote,
# and teaches the backend about a freshly-created frontend.
if [ -n "$BACKEND_URL" ] && [ -n "$FRONTEND_URL" ]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  FRONTEND_URL_ALT="https://${FRONTEND_SVC}-${PROJECT_NUMBER}.${REGION}.run.app"
  CORS_ORIGINS_VAL="$FRONTEND_URL"
  [ -n "$PROJECT_NUMBER" ] && [ "$FRONTEND_URL_ALT" != "$FRONTEND_URL" ] \
    && CORS_ORIGINS_VAL="$FRONTEND_URL,$FRONTEND_URL_ALT"
  # Fold in any custom domain(s) so the browser served from them may call the
  # backend. Without this, a site on https://example.com hits a CORS wall even
  # though the *.run.app origins are allowed.
  [ -n "${CUSTOM_DOMAINS:-}" ] && CORS_ORIGINS_VAL="$CORS_ORIGINS_VAL,$CUSTOM_DOMAINS"
  section "Wiring CORS: backend now trusts the frontend origin(s)"
  say "${DIM}$CORS_ORIGINS_VAL${RST}"
  # '^@^' makes '@' the pair-delimiter so the comma stays inside the value.
  gcloud run services update "$BACKEND_SVC" \
    --region "$REGION" --project "$PROJECT" \
    --update-env-vars "^@^CORS_ORIGINS=$CORS_ORIGINS_VAL" >/dev/null
  ok "Backend CORS_ORIGINS updated."
else
  warn "Skipping CORS wiring (need both a deployed backend and frontend URL)."
fi

# ---------------------------------------------------------------------------
# 12. Optional: seed the production database (backend deploys only)
# ---------------------------------------------------------------------------
if [ "$DO_BACKEND" = yes ]; then
section "Seed production database?"
say "The Datastore is empty — no menu and no login until seeded."
say "${DIM}Seeding runs backend/seed.py locally against live Datastore using your${RST}"
say "${DIM}application-default credentials (gcloud auth application-default login).${RST}"
if confirm "Seed the menu, owner/staff users, coupon and delivery areas now?"; then
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    warn "No application-default credentials found."
    say  "Run this once, then re-run deploy.sh and choose seed again:"
    say  "    gcloud auth application-default login"
  else
    # Seed credentials are asked for here (only used by seed.py, never stored
    # in the Cloud Run service env). Blank password => keep the dev default.
    ask OWNER_EMAIL "Owner login email" "${OWNER_EMAIL:-owner@shivpaneer.com}"
    ask_secret OWNER_PASSWORD "Owner password (input hidden, blank=owner123)"
    [ -n "$OWNER_PASSWORD" ] || OWNER_PASSWORD="owner123"
    ask STAFF_EMAIL "Staff login email" "${STAFF_EMAIL:-staff@shivpaneer.com}"
    ask_secret STAFF_PASSWORD "Staff password (input hidden, blank=staff123)"
    [ -n "$STAFF_PASSWORD" ] || STAFF_PASSWORD="staff123"
    # Ensure a venv with deps exists.
    VENV="$ROOT/backend/.venv"
    if [ ! -x "$VENV/bin/python" ]; then
      say "Creating backend virtualenv for the seed run…"
      python3 -m venv "$VENV"
      "$VENV/bin/pip" install -q --upgrade pip
      "$VENV/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
    fi
    say "Seeding…"
    ( cd "$ROOT/backend" && \
      DATASTORE_EMULATOR_HOST="" \
      GOOGLE_CLOUD_PROJECT="$PROJECT" \
      GCP_PROJECT_ID="$PROJECT" \
      DATASTORE_PROJECT_ID="$PROJECT" \
      DATASTORE_DATABASE="$DB_NAME" \
      OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$OWNER_PASSWORD" \
      STAFF_EMAIL="$STAFF_EMAIL" STAFF_PASSWORD="$STAFF_PASSWORD" \
      "$VENV/bin/python" seed.py ) \
      && ok "Seed complete." \
      || warn "Seed failed — you can re-run: (cd backend && DATASTORE_EMULATOR_HOST= GOOGLE_CLOUD_PROJECT=$PROJECT DATASTORE_DATABASE=$DB_NAME .venv/bin/python seed.py)"
  fi
else
  say "${DIM}Skipped. Seed later with the command above, or create the owner via${RST}"
  say "${DIM}the provisioning page using SETUP_KEY (see .deploy/secrets.env).${RST}"
fi
fi   # end DO_BACKEND (seed)

# ---------------------------------------------------------------------------
# 13. Done
# ---------------------------------------------------------------------------
section "Deployment complete 🎉"
cat <<EOF
  ${BOLD}Customer site${RST} : $FRONTEND_URL/index.html
  ${BOLD}Staff login${RST}   : $FRONTEND_URL/staff/login.html
  ${BOLD}Create users${RST}   : $FRONTEND_URL/provision.html  (X-Setup-Key below)
  ${BOLD}Backend API${RST}   : $BACKEND_URL
  API health     : $BACKEND_URL/health
  API docs       : $BACKEND_URL/docs

  Owner login    : ${OWNER_EMAIL:-<not seeded — create one on provision.html>}
  Setup key      : stored in .deploy/secrets.env  (X-Setup-Key for provision.html)

  ${DIM}Re-run ./deploy.sh anytime to redeploy code changes — it reuses your saved
  answers (.deploy/config.env) and secrets, so nobody gets logged out.${RST}

  ${YEL}Reminders${RST}
   • Add the Maps API key later:  gcloud run services update $BACKEND_SVC \\
       --region $REGION --update-env-vars MAPS_API_KEY=YOUR_KEY
   • For a custom domain, map it in Cloud Run and update CORS_ORIGINS to match.
   • .deploy/secrets.env holds live secrets — keep it off version control.
EOF
