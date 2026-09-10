#!/usr/bin/env python3
"""Static file server for local development, with caching turned off.

`python3 -m http.server` sends no Cache-Control header at all. That is not the
same as saying "don't cache" — with no header the browser falls back to its own
heuristic freshness and is free to keep serving a file it fetched earlier. So an
edited stylesheet or an edited script can stay stale in the tab long after it
changed on disk, and nothing in the terminal says so: the server logs a request
it never received.

That has cost real debugging time more than once — a replaced logo and a
rewritten WhatsApp message both looked like code that had not saved, when the
file on disk was correct and the browser simply never asked for it.

Production already gets this right: the nginx config in deploy.sh sends
`no-cache` for html/css/js and caches media hard for 30 days. This mirrors the
strict half of that, because on a dev server a cached asset is never what
anybody wanted.

  ./devserver.py                       # serve . on 127.0.0.1:5500
  ./devserver.py 8080 --directory web  # anywhere else
"""

import argparse
import functools
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler, but every response says not to keep it."""

    def end_headers(self):
        # `no-store` rather than `no-cache`: no-cache still permits a
        # conditional request, and a 304 from a local server saves nothing worth
        # the chance of getting the revalidation wrong. Pragma and Expires are
        # there for the same reason belts have braces — some proxies and older
        # engines only honour those.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser(description="Dev static server that never caches.")
    ap.add_argument("port", nargs="?", type=int, default=5500)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--directory", default=".")
    args = ap.parse_args()

    handler = functools.partial(NoCacheHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {args.directory} on http://{args.bind}:{args.port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
