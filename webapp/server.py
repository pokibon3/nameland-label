#!/usr/bin/env python3
"""Local server for the label app: serves the files with caching disabled and
relays print jobs from the MCP server (mcp/nameland_mcp.py) to the open app tab.

Bridge endpoints (all require the X-Nameland-Bridge header, so a page on
another origin cannot call them without a CORS preflight, which is refused):
  POST /bridge/job          submit a job, blocks until the app answers
  GET  /bridge/next         the app tab long-polls for the next job
  POST /bridge/result       the app tab returns a job's result
  GET  /bridge/status       when the app tab last polled
"""

import http.server
import json
import os
import queue
import sys
import threading
import time
import uuid

DEFAULT_PORT = 8123
BRIDGE_HEADER = "X-Nameland-Bridge"
POLL_WAIT_S = 20


class Bridge:
    def __init__(self):
        self.jobs = queue.Queue()
        self.waiting = {}          # job id -> {"event", "result"}
        self.lock = threading.Lock()
        self.last_seen = 0.0       # last time the app tab polled
        self.app_state = {}        # what the app reported with its last poll

    def submit(self, job, timeout):
        job_id = uuid.uuid4().hex
        slot = {"event": threading.Event(), "result": None}
        with self.lock:
            self.waiting[job_id] = slot
        self.jobs.put({**job, "id": job_id})
        try:
            if not slot["event"].wait(timeout):
                return {"ok": False, "error": "アプリから応答がありませんでした（タイムアウト）"}
            return slot["result"]
        finally:
            with self.lock:
                self.waiting.pop(job_id, None)

    def next(self, wait):
        deadline = time.time() + wait
        while True:
            try:
                job = self.jobs.get(timeout=max(0.01, deadline - time.time()))
            except queue.Empty:
                return None
            with self.lock:
                live = job["id"] in self.waiting
            if live:
                return job   # skip jobs whose submitter already gave up

    def answer(self, job_id, result):
        with self.lock:
            slot = self.waiting.get(job_id)
        if slot:
            slot["result"] = result
            slot["event"].set()


def make_handler(root, bridge, port):
    allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=root, **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

        def log_message(self, fmt, *args):
            if not self.path.startswith("/bridge/"):
                super().log_message(fmt, *args)

        def send_json(self, code, body=None):
            data = json.dumps(body if body is not None else {}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def bridge_allowed(self):
            # the header blocks cross-origin pages; the Host check blocks DNS rebinding
            if not self.headers.get(BRIDGE_HEADER) or self.headers.get("Host") not in allowed_hosts:
                self.send_json(403, {"error": "forbidden"})
                return False
            return True

        def read_json(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            if not self.path.startswith("/bridge/"):
                return super().do_GET()
            if not self.bridge_allowed():
                return
            path, _, query = self.path.partition("?")
            if path == "/bridge/status":
                return self.send_json(200, {
                    "bridge": True,
                    "appSeenAgo": time.time() - bridge.last_seen if bridge.last_seen else None,
                    "app": bridge.app_state,
                })
            if path == "/bridge/next":
                bridge.last_seen = time.time()
                try:
                    bridge.app_state = json.loads(self.headers.get("X-Nameland-State") or "{}")
                except ValueError:
                    pass
                job = bridge.next(POLL_WAIT_S)
                bridge.last_seen = time.time()
                if job is None:
                    self.send_response(204)
                    self.end_headers()
                    return
                try:
                    return self.send_json(200, job)
                except OSError:
                    bridge.jobs.put(job)   # the tab went away mid-poll; let another take it
                    raise
            self.send_json(404, {"error": "not found"})

        def do_POST(self):
            if not self.path.startswith("/bridge/"):
                return self.send_json(404, {"error": "not found"})
            if not self.bridge_allowed():
                return
            try:
                body = self.read_json()
            except ValueError:
                return self.send_json(400, {"error": "bad json"})
            if self.path == "/bridge/job":
                timeout = float(body.pop("timeout", 60))
                return self.send_json(200, bridge.submit(body, timeout))
            if self.path == "/bridge/result":
                bridge.answer(body.get("id"), body.get("result") or {"ok": False, "error": "empty result"})
                return self.send_json(200)
            self.send_json(404, {"error": "not found"})

    return Handler


def make_server(port=DEFAULT_PORT, root=None):
    root = root or os.path.dirname(os.path.abspath(__file__))
    bridge = Bridge()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(root, bridge, port))
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = make_server(port)
    print(f"Serving on http://localhost:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
