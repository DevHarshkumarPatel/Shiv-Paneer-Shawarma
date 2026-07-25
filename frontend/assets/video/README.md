# Backdrop video assets

`index.html` plays these behind the landing hero, with `../img/hero-poster.jpg` as
the poster. Two encodes, picked at runtime by `frontend/js/bgvideo.js`:

| File | Used by | Why |
|---|---|---|
| `hero.mp4` (1280w) | desktop, >700px | hero backdrop, full width |
| `hero-sm.mp4` (720w) | phones, ≤700px | short hero band — 1280 is wasted bytes |

Committed, not built by `deploy.sh`. Regenerate by hand when the clip changes.

**No WebM.** VP9 encodes of this clip came out *larger* than x264 (1.7 MB vs
1.4 MB at matched quality), and every browser we target plays H.264. If the
source clip changes character, re-measure before assuming that still holds — a
WebM that loses on size but is listed first is worse than no WebM at all.

## Regenerating from a source clip

Requires `ffmpeg`. From the repo root:

```bash
SRC="/path/to/source.mp4"
OUT=frontend/assets/video
TRIM="-t 20.5"        # see "Trim the promo tail" below; drop if not needed

# Poster — the first paint, and the ONLY thing shown under
# prefers-reduced-motion / Save-Data. Pick a strong frame.
ffmpeg -y -ss 6 -i "$SRC" -vf "scale=1280:-2" -frames:v 1 -q:v 4 \
  frontend/assets/img/hero-poster.jpg

# Desktop
ffmpeg -y $TRIM -i "$SRC" -an -c:v libx264 -crf 36 -preset slow \
  -vf "scale=1280:-2,fps=24" -profile:v main -pix_fmt yuv420p \
  -movflags +faststart "$OUT/hero.mp4"

# Mobile
ffmpeg -y $TRIM -i "$SRC" -an -c:v libx264 -crf 34 -preset slow \
  -vf "scale=720:-2,fps=24" -profile:v main -pix_fmt yuv420p \
  -movflags +faststart "$OUT/hero-sm.mp4"

ls -lh "$OUT" frontend/assets/img/hero-poster.jpg
```

`-an` strips audio: the element is muted, so an audio track is pure waste.
`-movflags +faststart` moves the index to the front — without it playback waits
for the whole download.

## Trim the promo tail

The current source is a 30 s marketing clip whose last ~9 s carry **baked-in
text** ("Monsoon Special — BUY 1 SHAWARMA & GET 1 FREE", "Celebrate Our Website
Launch"). That is cut off at 20.5 s on purpose:

- A hard-coded offer looping behind the live menu promises something the
  ordering system does not enforce. It cannot be switched off without an image
  redeploy, and it will still be running long after the offer ends.
- `object-fit: cover` crops the frame, so the text is chopped anyway, and
  behind the scrim it is washed out regardless.

Use the offers/coupons feature for real promotions. Keep this clip as food
footage only.

## Budget

Keep the desktop file **under ~1.5 MB** and mobile **under ~750 KB**. This is
the heaviest asset on the landing page and it loads before anyone has ordered.
Trim the clip shorter before raising CRF — a long clip at high quality is the
worst of both. `deploy.sh` serves `/assets/video/` with `expires 30d;
immutable`, so filenames are not hashed: rename the file (and the `data-mp4*`
attributes in `index.html`) to push a replacement to repeat visitors sooner.
