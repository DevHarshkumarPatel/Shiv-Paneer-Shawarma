# Backdrop video assets

`index.html` plays these behind the landing hero, with `../img/hero-poster-v2.jpg`
as the poster. Two encodes, picked at runtime by `frontend/js/bgvideo.js`:

| File | Used by | Why |
|---|---|---|
| `hero-v2.mp4` (1280w) | desktop, >700px | hero backdrop, full width |
| `hero-v2-sm.mp4` (720w) | phones, ≤700px | short hero band — 1280 is wasted bytes |

Committed, not built by `deploy.sh`. Regenerate by hand when the clip changes.

Filenames carry a `-v2` suffix because `deploy.sh` serves media with `expires
30d; immutable` and does **not** content-hash names. A replacement written to
the old filename stays invisible to repeat visitors for up to 30 days, so a new
clip means a new name — bump to `-v3` and update the `data-mp4*`/`poster`
attributes in `index.html` plus the `og:image` references in `index.html` and
`menu.html`.

**No WebM.** VP9 encodes of this clip came out *larger* than x264 (4.9 MB vs
3.4 MB at matched quality), and every browser we target plays H.264. Measured
again on the current clip, so the original conclusion still holds. If the
source clip changes character, re-measure before assuming it keeps holding — a
WebM that loses on size but is listed first is worse than no WebM at all.

## Regenerating from a source clip

Requires `ffmpeg`. From the repo root:

```bash
SRC="/path/to/source.mp4"
OUT=frontend/assets/video

# Poster — the first paint, and the ONLY thing shown under
# prefers-reduced-motion / Save-Data. Frame 0 of the current clip is a clean
# single-wrap shot, which also means the poster does not visibly swap when
# playback starts. Pick a strong frame that matches the opening.
ffmpeg -y -ss 0 -i "$SRC" -vf "scale=1280:-2" -frames:v 1 -q:v 4 \
  frontend/assets/img/hero-poster-v2.jpg

# Desktop
ffmpeg -y -i "$SRC" -an -c:v libx264 -crf 31 -preset slow \
  -vf "scale=1280:-2,fps=24" -profile:v high -level 4.0 -pix_fmt yuv420p \
  -movflags +faststart "$OUT/hero-v2.mp4"

# Mobile
ffmpeg -y -i "$SRC" -an -c:v libx264 -crf 31 -preset slow \
  -vf "scale=720:-2,fps=24" -profile:v high -level 3.1 -pix_fmt yuv420p \
  -movflags +faststart "$OUT/hero-v2-sm.mp4"

ls -lh "$OUT" frontend/assets/img/hero-poster-v2.jpg
```

`-an` strips audio: the element is muted, so an audio track is pure waste. The
current source ships a 128 kbps AAC track that this drops.
`-movflags +faststart` moves the index to the front — without it playback waits
for the whole download.

CRF 31 is a floor for this clip, not a free knob. At CRF 34 the paneer char
marks and chilli edges smear into mush, which is the one thing a food hero is
there to show. Prefer a shorter clip over a higher CRF.

## Baked-in promo text — currently on screen

The clip is a 30 s marketing render whose last ~10 s carry **baked-in text**:
"Monsoon Special — BUY 1 SHAWARMA & GET 1 SHAWARMA FREE" (~21–25 s) and a
"Shiv Paneer Shawarma / Celebrate Our Website Launch!" title card (~26–30 s).

The full 30 s is shipped on purpose, by request. Know what that means:

- The buy-one-get-one line loops behind the live menu as an offer the ordering
  system does not enforce, and it cannot be switched off without an image
  redeploy — it will still be running long after the offer ends.
- `object-fit: cover` crops the frame and the scrim washes it out, so the text
  is chopped and faded rather than legible — bad as an ad, still legible enough
  to be read as a promise.

The previous encode cut this at 20.5 s (`-t 20.5`) for exactly that reason. To
restore the cut, add `-t 20.5` to both video commands above; the food-only
footage runs 0–20.5 s. Use the offers/coupons feature for real promotions.

## Budget

The intended budget is desktop **under ~1.5 MB** and mobile **under ~750 KB**.
This is the heaviest asset on the landing page and it loads before anyone has
ordered.

**The current files exceed it: 3.4 MB desktop, 1.5 MB mobile.** The clip is
30 s instead of 20.5 s and has far more motion and fine texture than the one
the budget was written for, so no CRF that keeps the food looking like food
gets under the cap. Trimming to the 20.5 s food-only section is the lever that
brings it back in range. `preload="none"` keeps this off the critical path —
the poster paints first and the video is fetched after — so the cost is
bandwidth and mobile data, not Largest Contentful Paint.
