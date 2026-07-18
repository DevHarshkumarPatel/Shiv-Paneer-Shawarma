# Shiv Paneer Shawarma — Ordering Platform

A professional, mobile-first restaurant ordering website with online + offline ordering,
live order tracking, UPI payments, and a staff/owner back-office.

- **Frontend** — pure HTML/CSS/JS (no framework), fully responsive. Folder: [`frontend/`](frontend/)
- **Backend** — FastAPI. Folder: [`backend/`](backend/)
- **Database** — Google Cloud NDB (Datastore); local **Datastore emulator** for development.

## Features

**Customer**
- Landing page → choose **Dine-in / Takeaway / Delivery**
- Menu with category tabs, **Buy-2-Get-1** offers, a base × size price grid (Wheat/Millets ×
  Regular/Exotic), and a "choose base + size" add-to-cart modal
- Cart with live server-side pricing, **coupons/promos**, and delivery fee
- Delivery: address + **Google Maps** pin (auto-locate / draggable) — graceful fallback until a key is set
- **UPI QR** payment (GPay/PhonePe/Paytm) with reference (UTR) capture; delivery is prepaid
- Every order gets an id (e.g. `SPS-260718-0042`) with a **live tracking** timeline

**Staff / Owner** (separate URL, JWT-in-cookie auth)
- Live orders board across all channels with **status updates** and **payment verification**
- Owner-only **Menu & Offers** admin: categories, items, per-variant prices, item/category promos, coupons

Pricing (promos, B2G1, coupons, delivery) is **computed authoritatively on the backend** so totals
can't be tampered with from the client.

## Prerequisites

- Python 3.11+
- Google Cloud SDK with the Datastore emulator + Java:
  ```bash
  gcloud components install cloud-datastore-emulator
  ```
- Any static file server (Python's `http.server` is fine).

## Quick start

**Interactive control panel (recommended):**

```bash
# from the repo root
./dev.sh
```

A friendly menu lets you start the **backend**, the **frontend**, or **both**, browse the
**database**, seed/reset data, check status, tail logs, and stop everything. First run auto-creates
the virtualenv and installs dependencies.

Non-interactive shortcuts are available too:

```bash
./dev.sh start      # start database + API + website
./dev.sh backend    # database + API only
./dev.sh frontend   # website only
./dev.sh db menu    # print the menu straight from the database
./dev.sh status     # what's running

# stop individually or all at once:
./dev.sh stop frontend   # stop just the website
./dev.sh stop backend    # stop just the API
./dev.sh stop database   # stop just the emulator
./dev.sh stop            # stop everything
```

In the interactive menu, choose **8) Stop** to stop the frontend, backend, database, or all —
each independently. Stops also catch servers started outside the panel (by port).

**One-shot foreground launcher** (starts all three and blocks until Ctrl-C):

```bash
./run.sh
```

Either way the API comes up on **:8000** and the frontend on **:5500**. Then open:

| Page            | URL                                   |
|-----------------|----------------------------------------|
| Customer site   | http://127.0.0.1:5500/index.html       |
| Menu / ordering | http://127.0.0.1:5500/menu.html         |
| Track an order  | http://127.0.0.1:5500/track.html        |
| Staff / Owner   | http://127.0.0.1:5500/staff/login.html  |
| API docs        | http://127.0.0.1:8000/docs              |

**Seed logins:** owner `owner@shivpaneer.com / owner123` · staff `staff@shivpaneer.com / staff123`
**Sample coupon:** `SHIV10` (10% off, min ₹200, cap ₹60)

## Manual start (four terminals / steps)

```bash
# 1) Datastore emulator
gcloud beta emulators datastore start --project=shiv-paneer-shawarma \
  --host-port=localhost:8081 --no-store-on-disk --consistency=1.0

# 2) Backend deps + config
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # edit values as needed

# 3) Seed + run API
python seed.py                # add --reset to rebuild
uvicorn app.main:app --reload --port 8000

# 4) Serve the frontend
cd ../frontend
python3 -m http.server 5500 --bind 127.0.0.1
```

## Configuration (`backend/.env`)

Copy from [`backend/.env.example`](backend/.env.example). Key values you'll want to set for production:

| Variable            | Purpose                                                             |
|---------------------|--------------------------------------------------------------------|
| `JWT_SECRET`        | **Change this.** `python -c "import secrets;print(secrets.token_hex(32))"` |
| `UPI_VPA` / `UPI_PAYEE_NAME` | Your restaurant's UPI id + display name for the payment QR |
| `MAPS_API_KEY`      | Google Maps Platform key (JS + Places) for the delivery map picker |
| `DELIVERY_FEE`      | Flat delivery fee (INR) applied to delivery orders                 |
| `CORS_ORIGINS`      | Allowed frontend origins                                           |

The frontend's API base URL is in [`frontend/js/config.js`](frontend/js/config.js).

### Going to production (real Datastore)

Leave `DATASTORE_EMULATOR_HOST` empty and set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account
key with Datastore access. The application code is unchanged. Serve the frontend from any static host
and set `COOKIE_SECURE=true` (HTTPS) and a proper `CORS_ORIGINS`.

## Project layout

```
backend/
  app/
    main.py            # app wiring, CORS, /health, /api/config
    config.py db.py    # settings + NDB client (emulator-aware context wrapper)
    security.py deps.py# JWT/cookies + auth dependencies
    models/            # User, Category, Subcategory, Item(+Variant), Promo, Coupon, Order, Counter
    schemas/           # Pydantic request/response models
    routers/           # menu_public, auth, menu_admin, coupons, orders, orders_admin, payments
    services/          # pricing (authoritative), order_ids, upi (QR)
  seed.py              # menu + users + promos + sample coupon
  inspect_db.py        # read-only DB viewer (summary/menu/orders/users/coupons)
frontend/
  index.html menu.html checkout.html track.html
  staff/ (login, orders, menu-admin)
  assets/css/ (tokens, base, components, menu, checkout, staff)
  js/ (config, api, ui, store, menu, checkout, track) + js/staff/ (auth, orders, menu-admin)
```

## Order status flow

`placed → confirmed → preparing → packing → ready → …`
- **delivery:** … → `on_the_way` → `delivered`
- **takeaway:** … → `picked_up`
- **dine_in:** `placed → confirmed → preparing → ready → served`

Customers watch the same flow on the track page; staff/owner advance it. `cancelled` is terminal.
