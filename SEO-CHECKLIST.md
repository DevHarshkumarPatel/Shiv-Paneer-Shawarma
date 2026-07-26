# Ranking for "best shawarma in Surat" and "veg shawarma in Surat"

Read this before touching the SEO markup — the code half is done, and it is the
*smaller* half.

## The honest version of what decides these rankings

Both target queries are **local-intent** queries. Google answers them with the
**map pack** (the 3 pins above the blue links), and the map pack is ranked from
the **Google Business Profile**, not from the website. The blue-link results
below it are dominated by aggregators — Zomato, Swiggy, JustDial, MagicPin — who
have thousands of backlinks the site cannot match this year.

So, realistically:

| Slot | Can we win it? | What decides it |
|---|---|---|
| Map pack for "best shawarma in Surat" | **Yes, this is the goal** | Google Business Profile + review count/velocity + proximity to the searcher |
| Blue link #1 for "veg shawarma in Surat" | Plausible in 3–6 months | On-page (done) + reviews + citations + a few real backlinks |
| Blue link #1 for "best shawarma in Surat" | Unlikely — aggregator pages own it | Their domain authority |

Nobody can promise position #1 — Google ranks by searcher location too, so
"first" is different for a user in Adajan and a user in Varachha. The plan below
is what actually moves it, in priority order.

## 1. Fill in the placeholders (blocking — do this first)

Every `TODO(SEO)` in the code needs the real value. Grep for them:

```bash
grep -rn "TODO(SEO)" frontend/
```

They live in:

- [frontend/index.html](frontend/index.html) — `Restaurant` JSON-LD in the head
  (street address, postal code, latitude/longitude, Google Maps link, `sameAs`
  profile URLs), the "Find us" section, and the footer `<address>`.
- Opening hours appear in **three** places (JSON-LD, Find-us card, footer). Keep
  them identical.

Needed facts:

1. ~~Street address~~ — done: `Shiv Complex, 4, beside Velocity Complex, near
   Madhuvan Circle, TGB, L.P. Savani, Surat, Gujarat 395009`
2. ~~Pincode~~ — done: `395009`
3. ~~Latitude / longitude~~ — done: `21.1912337, 72.788374` (taken from the
   listing's own pin, not from a map-centre link)
4. ~~Public phone number~~ — done: `+91 76220 09528`
5. ~~Google Maps link~~ — done: `https://maps.app.goo.gl/cdyQocMg91kS9HUCA`
   (the listing's own place link, used for `hasMap` and the Get-directions
   button). It resolves to the **SHIV PANEER SHAWARMA** listing, so the profile
   already exists — see §2, it needs optimising, not creating.
   Stable identifiers pulled out of it, worth keeping:
   - CID: `13030903932341080586` → `https://maps.google.com/?cid=13030903932341080586`
     (this is the form in `sameAs`; short links can rotate, a CID cannot)
   - Google FID: `/g/11rt_mjpsp`
   - Pin coords: `21.1912337, 72.788374`
6. ~~Opening hours~~ — done: **17:00–23:00, all seven days**, no weekly off.
   Lives in four places now: the `openingHoursSpecification`, the Find-us card,
   the footer, and an FAQ entry. Change all four together.
7. ~~Delivery areas~~ — done: 20 areas, in the `.lp-areas` pill list, in
   `areaServed`, and in an FAQ answer. Alphabetical; keep all three in sync.
8. **Still needed:** Instagram / Zomato / Swiggy URLs, to append to the `sameAs`
   array (the Maps listing is already in there) — the last `TODO(SEO)`.

The 20 delivery areas are the highest-yield long-tail on the site: "shawarma
delivery Adajan", "veg shawarma Vesu", "shawarma near Majura Gate" each have a
tiny fraction of the competition of the head term. Do **not** turn them into 20
separate pages — for one outlet that is a doorway-page pattern and a demotion
risk. The one list on the homepage is the right shape. Set the same areas as the
service area on the Business Profile.

Evening-only hours have one consequence worth knowing: Google's "Open now"
filter and the `open now` slice of "shawarma near me" hide the listing for the
whole day. Set the same 5–11 pm on the Business Profile so at least the two
agree, and lean on the ordering master switch so the site is not taking orders
at 2 pm that nobody is there to cook.

Use the phone and address above **verbatim** on the Google Business Profile and
on every citation site — that identical string is the whole point.

The shop sits at **Madhuvan Circle** (L.P. Savani / TGB, west Surat). The site
leads with **Madhuvan Circle**, not L.P. Savani — that is the landmark people
here search and navigate by, so it is what the H2, the section copy, the
`areaServed` list and the JSON-LD description all say. "shawarma near Madhuvan
Circle" is far lower-competition than "best shawarma in Surat" and this shop can
own it outright while the city-level term is still climbing.

The one exception: the **street address** still reads `… near Madhuvan Circle,
TGB, L.P. Savani` in both the JSON-LD and the visible `<address>`. That is the
Google Business Profile string and it stays verbatim — the citation only counts
while it matches.

**Why exactness matters:** the address/phone/name on the site must match the
Google Business Profile character-for-character. A mismatched citation subtracts
trust instead of adding it.

## 2. Google Business Profile — the single biggest lever

The listing **already exists** — the Maps link above resolves to
`SHIV PANEER SHAWARMA`, CID `13030903932341080586`. So this section is about
claiming and optimising it, not creating it. Until that is done, nothing else
here matters.

- Claim/verify the listing at <https://business.google.com>. If someone else
  created it, use "Own this business?" on the Maps listing to request access.
- Cross-check the profile against what the site now says — they must agree:
  phone `+91 76220 09528`, hours **5:00 pm–11:00 pm daily**, and the address
  string `SHIV COMPLEX, 4, beside VELOCITY COMPLEX, near Madhuvan Circle, TGB,
  L.P.Savani, Surat, Gujarat 395009`.
- Primary category: **Shawarma restaurant**. Secondary: *Fast food restaurant*,
  *Vegetarian restaurant*.
- Business name = `Shiv Paneer Shawarma`. Do **not** stuff it to
  "Shiv Paneer Shawarma Best Veg Shawarma Surat" — that is a suspension risk and
  competitors report it.
- Set the service area to the Surat areas you deliver to.
- Add the website link → `https://shivpaneershawarma.com/`, and the menu link →
  `https://shivpaneershawarma.com/menu.html`.
- Upload **20+ real photos** (shawarma being rolled, the counter, the shopfront
  with signage, packed delivery bags). Geotagged, shot on a phone at the shop.
  Photo volume and freshness measurably affect local pack position.
- Post a GBP **Update** weekly (the B1G1 offer, a new item). Free, and it keeps
  the listing active.
- Fill the **Q&A** section yourself with the same questions as the site FAQ.
- Enable messaging so "best shawarma in Surat" searchers can ping directly.

## 3. Reviews — what actually ranks you above the next shawarma shop

Review **count** and **recency** are the strongest map-pack factors you control.
The phrase in the review text matters too: a review saying *"best veg shawarma in
Surat"* is a relevance signal for exactly that query.

- Print a review QR on the bill, the counter, and the delivery packaging. Until
  the profile is claimed (which gives you a proper short link), this works:
  `https://search.google.com/local/writereview?placeid=` needs the `ChIJ…` id,
  but `https://maps.google.com/?cid=13030903932341080586` opens the listing
  directly and the Review button is one tap away.
- Ask every dine-in customer at payment. Target ~30 reviews in the first two
  months, then a steady trickle — a sudden burst of 50 looks bought.
- Reply to **every** review, including the bad ones. Replies are indexed.
- Never buy reviews. It is detectable and the listing gets filtered.

## 4. Citations — get listed everywhere with identical NAP

Same name, address, phone everywhere:

Zomato · Swiggy · JustDial · MagicPin · Sulekha · IndiaMART · Apple Maps
(<https://register.apple.com/placesonmaps>) · Bing Places · Facebook Page ·
Instagram bio with the address · 2GIS/Nearbuy if relevant.

Being on Zomato/Swiggy is not a competitor to the site — those listings rank for
the query and they carry the brand name, which then gets searched directly.

## 5. Search Console — set up once, then watch

```bash
# domain verification was already needed for the Cloud Run mapping:
gcloud domains verify shivpaneershawarma.com
```

- Add the property in <https://search.google.com/search-console>.
- Submit `https://shivpaneershawarma.com/sitemap.xml`.
- Use **URL Inspection → Request indexing** for `/` and `/menu.html` after the
  next deploy. Don't wait for the crawler.
- Check *Performance → Queries* after 3–4 weeks to see which shawarma phrases the
  site is actually appearing for, and write copy for the ones at position 8–20 —
  those are the cheapest to push onto page one.
- Also validate the structured data:
  <https://search.google.com/test/rich-results> — paste the live URL. The
  `Restaurant` and `FAQPage` blocks must both be detected with no errors.

## 6. Content that earns the query (next iteration)

The homepage now carries the phrases. To go further, in rough value order:

1. **A page per delivery area** only if you genuinely serve them differently —
   otherwise it is a doorway-page pattern and is a demotion risk. For a single
   outlet, one strong homepage beats ten thin area pages.
2. A short **blog/story page**: "Why our shawarma uses whole wheat and millet, not
   maida". Real content that local food bloggers can link to.
3. Get **2–5 real backlinks**: Surat food Instagram pages, a local news/food blog
   feature, the shopping-complex or society website, a college fest sponsorship
   page. Five relevant local links beat 500 bought ones.

## 7. Technical state (done in code — for reference)

| Item | Where | Status |
|---|---|---|
| `<!doctype html>` + `lang="en-IN"` on every page | all `frontend/*.html` | done (they were rendering in **quirks mode** before) |
| City in `<title>`, meta description, `<h1>` | `index.html`, `menu.html` | done |
| Canonical URLs | `index.html`, `menu.html` | done |
| `Restaurant` JSON-LD (address, geo, hours, menu, area served) | `index.html` head | done, needs the real values |
| `FAQPage` JSON-LD + matching visible FAQ | `index.html` | done |
| `Menu` JSON-LD | `menu.html` head | done |
| Open Graph / WhatsApp preview | `index.html`, `menu.html` | done |
| Crawlable `<h1>` on the JS-rendered menu page | `menu.html` | done (there was none) |
| `noindex` on checkout / track / staff / provision | those pages | done |
| `robots.txt` + `sitemap.xml` | `frontend/` | done |
| gzip for HTML/CSS/JS/JSON-LD | nginx block in `deploy.sh` | done |
| LCP preload of the hero poster | `index.html` | done |
| No fake `aggregateRating` | — | deliberate: self-declared ratings are ignored or penalised |

### Two things left on the technical side

- **`www` → apex redirect.** Both `shivpaneershawarma.com` and
  `www.shivpaneershawarma.com` are mapped to the same Cloud Run service, which is
  duplicate content. The `<link rel="canonical">` tags make this safe, but a real
  301 is cleaner — do it as a Cloudflare **Redirect Rule**
  (`www.shivpaneershawarma.com/*` → `https://shivpaneershawarma.com/$1`, 301).
  See [CLOUDFLARE_DOMAIN_SETUP.md](CLOUDFLARE_DOMAIN_SETUP.md).
- **Hero video weight.** `assets/video/hero.mp4` is the heaviest thing on the
  landing page. `bgvideo.js` already defers it and serves a smaller phone encode,
  so this is fine — but if PageSpeed flags LCP, drop the video on 4G/slow
  connections too, not just Save-Data.

## Timeline to expect

- **Week 1:** placeholders filled, GBP claimed, Search Console submitted.
- **Weeks 2–6:** reviews accumulate; the listing starts showing for
  "shawarma near me" inside ~2 km of the shop.
- **Months 2–4:** with 30+ reviews and the citations live, the map pack for
  "best shawarma in Surat" / "veg shawarma in Surat" becomes realistic.
- Blue-link #1 against Zomato for the head term is a longer game and may never
  happen — the map pack is the win worth chasing.
