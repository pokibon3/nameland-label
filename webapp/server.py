#!/usr/bin/env python3
"""Development server with caching disabled for reliable local iteration."""

import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
server = http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
print(f"Serving on http://localhost:{port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
