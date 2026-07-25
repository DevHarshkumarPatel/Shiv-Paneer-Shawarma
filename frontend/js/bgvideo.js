/* Backdrop / hero video loader.

   The <video> ships with NO <source> children on purpose — a source in the
   markup downloads on every visit, and this is the heaviest asset on the menu
   page. Sources are attached here, only when playing is actually appropriate.
   Whenever they are not, the element keeps painting its poster image and
   nothing is fetched at all. */
(() => {
  const v = document.querySelector("[data-bgvideo]");
  if (!v) return;

  // Two signals that mean "do not download this": an accessibility setting,
  // and the user explicitly asking the browser to conserve data. The poster is
  // a complete fallback on its own, so there is nothing else to do.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (navigator.connection && navigator.connection.saveData) return;

  // Phones play the video in a short hero band, not as a full-page backdrop,
  // so the desktop-sized encode would be wasted bytes — and phones are the
  // bulk of the traffic. Listing the full-size file after it is a real
  // fallback, not decoration: the browser walks to the next <source> when one
  // fails to load, so a missing -sm encode degrades instead of breaking.
  //
  // H.264 MP4 only, no WebM: VP9 encodes of this clip came out *larger* than
  // x264 (1.7M vs 1.4M), and every target browser plays H.264. Re-test if the
  // source clip ever changes character — the answer is content-dependent.
  const small = window.matchMedia("(max-width: 700px)").matches;
  const sources = small
    ? [v.dataset.mp4Sm, v.dataset.mp4]
    : [v.dataset.mp4];

  for (const src of sources) {
    if (!src) continue;
    const s = document.createElement("source");
    s.type = "video/mp4";
    s.src = src;
    v.appendChild(s);
  }
  v.load();

  // Autoplay can still be refused (iOS Low Power Mode, some enterprise
  // policies). Nothing to recover from — the poster stays up.
  const play = () => v.play().catch(() => {});
  play();

  // Don't decode frames nobody can see. On mobile the hero band scrolls out of
  // view almost immediately, so this is most of the video's life on the page.
  let onScreen = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen) play();
      else v.pause();
    }).observe(v);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) v.pause();
    else if (onScreen) play();
  });
})();
