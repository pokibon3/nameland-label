#!/usr/bin/env python3
"""MCP server (stdio) that prints labels and image files on the KL-SP100 through the web app.

The app keeps doing the rendering and the USB / Bluetooth work; this server
only hands it jobs. It also serves the app on http://localhost:8123 (the same
server as webapp/server.py), and opens the app in Chrome when no tab is open.
If another process already serves the port, that server is used instead.

Standard library only. Logs go to stderr; stdout carries JSON-RPC.
"""

import base64
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEBAPP = os.path.join(os.path.dirname(HERE), "webapp")
sys.path.insert(0, WEBAPP)
import server as appserver  # noqa: E402

PORT = int(os.environ.get("NAMELAND_PORT", appserver.DEFAULT_PORT))
BASE = f"http://localhost:{PORT}"
SERVER_INFO = {"name": "nameland", "version": "1.1.15"}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ---------- talking to the local server / app ----------

class BridgeError(Exception):
    pass


def http(method, path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        appserver.BRIDGE_HEADER: "1", "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read() or b"{}")


_own_server = None
_server_started = 0.0
# an already open tab retries every 10 s at most; give it that long to find a new server
RECONNECT_GRACE_S = 12


def start_server():
    global _own_server, _server_started
    try:
        srv = appserver.make_server(PORT, WEBAPP)
    except OSError:
        return False   # someone else got the port first
    _own_server = srv
    _server_started = time.time()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"serving the app on {BASE}")
    return True


def status():
    """Bridge status, starting our own server when nothing listens on the port."""
    for _ in range(2):
        try:
            return http("GET", "/bridge/status", timeout=3)
        except urllib.error.HTTPError as e:
            raise BridgeError(
                f"{BASE} で中継機能のない古いサーバーが動いています（serve.sh など）。止めてから再実行してください。") from e
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            start_server()
    raise BridgeError(f"{BASE} のサーバーを起動できませんでした")


def app_alive(st):
    ago = st.get("appSeenAgo")
    return ago is not None and ago < appserver.POLL_WAIT_S + 5


def open_browser():
    url = f"{BASE}/"
    for cmd in (["open", "-a", "Google Chrome", url], ["open", url]):
        try:
            if subprocess.run(cmd, capture_output=True, timeout=10).returncode == 0:
                return
        except (OSError, subprocess.SubprocessError):
            pass
    raise BridgeError(f"ブラウザを開けませんでした。Chrome で {url} を開いてください。")


def ensure_app(wait_s=30):
    st = status()
    if app_alive(st):
        return st
    while time.time() < _server_started + RECONNECT_GRACE_S:
        time.sleep(0.5)
        st = status()
        if app_alive(st):
            return st
    log("no app tab; opening the browser")
    open_browser()
    deadline = time.time() + wait_s
    while time.time() < deadline:
        time.sleep(0.5)
        st = status()
        if app_alive(st):
            return st
    raise BridgeError(f"アプリのタブが応答しません。Chrome で {BASE}/ を開いてください。")


def run_job(kind, args, timeout):
    ensure_app()
    result = http("POST", "/bridge/job", {"type": kind, "args": args, "timeout": timeout}, timeout=timeout + 10)
    if not result.get("ok"):
        raise BridgeError(result.get("error") or "失敗しました")
    return result


# ---------- tools ----------

LABEL_PROPS = {
    "text": {"type": "string", "description": "ラベルの文字。改行(\\n)で複数行。QR/バーコードだけなら空でよい"},
    "tape_mm": {"type": "number", "enum": [3.5, 6, 9, 12, 18, 24],
                "description": "テープ幅。省略するとプリンターに装着されたテープ（未接続ならアプリの設定）"},
    "font": {"type": "string", "description": "フォント名（例: ヒラギノ角ゴシック, Hiragino Mincho ProN, 游ゴシック, Mac のフォント名）"},
    "font_style": {"type": "string", "description": "フォントのスタイル（例: W3, W6, Bold）"},
    "font_scale": {"type": "integer", "minimum": 30, "maximum": 100, "description": "文字の大きさ %（100 = テープいっぱい）"},
    "align": {"type": "string", "enum": ["left", "center", "right"], "description": "行の揃え"},
    "frame": {"type": "string", "enum": ["none", "rect", "round", "double", "capsule"], "description": "枠"},
    "invert": {"type": "boolean", "description": "白黒反転"},
    "length_mm": {"type": "number", "minimum": 0,
                  "description": "ラベルの長さ（余白込み）。0 または省略で文字に合わせて自動"},
    "margin": {"type": "string", "enum": ["small", "medium", "large"], "description": "両端の余白（小 3mm / 中 10mm / 大 21mm）"},
    "code": {"type": "string", "enum": ["none", "qr", "barcode"], "description": "コード。省略時は none"},
    "code_position": {"type": "string", "enum": ["left", "right"], "description": "コードを置く側"},
    "qr_text": {"type": "string", "description": "QR コードの内容（code=qr のとき）"},
    "barcode_type": {"type": "string", "enum": ["code128", "ean13", "ean8"], "description": "バーコードの種類"},
    "barcode_text": {"type": "string", "description": "バーコードの内容（code=barcode のとき）"},
    "barcode_show_text": {"type": "boolean", "description": "バーコードの下に数字を表示"},
}

PRINT_PROPS = {
    **LABEL_PROPS,
    "copies": {"type": "integer", "minimum": 1, "maximum": 99, "description": "枚数（既定 1）"},
    "density": {"type": "integer", "minimum": 1, "maximum": 5, "description": "印字濃度（3 = 標準）"},
    "cutting": {"type": "string", "enum": ["full", "full_half", "none"], "description": "カット方法"},
}

IMAGE_PROPS = {
    "path": {"type": "string", "description": "画像ファイルの絶対パス（PNG / JPEG / GIF / WebP / BMP / SVG）。白地に黒で描いたもの。透明部分は印字しない"},
    "size": {"type": "string", "enum": ["fit", "actual"],
             "description": "fit（既定）: 画像の高さをテープの印字幅いっぱいに合わせる。actual: 画像の実寸で印字（SVG は mm/in の寸法、ラスタは dpi）。"
                            "印字幅は 3.5/6/9/12/18/24mm テープで 2/4/7/10/16/18mm（8 dot/mm）"},
    "dpi": {"type": "number", "minimum": 1,
            "description": "size=actual のときのラスタ画像の解像度。省略時は 1 画素 = 1 ドット（203.2 dpi）、SVG は 96"},
    "tape_mm": LABEL_PROPS["tape_mm"],
    "invert": LABEL_PROPS["invert"],
    "margin": LABEL_PROPS["margin"],
}

PRINT_IMAGE_PROPS = {**IMAGE_PROPS, **{k: PRINT_PROPS[k] for k in ("copies", "density", "cutting")}}

IMAGE_TYPES = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024

TOOLS = [
    {
        "name": "print_label",
        "description": "KL-SP100 でラベルを印刷する。指定しなかった項目はアプリの現在の設定を使う。"
                       "アプリのタブが開いていなければ Chrome で開き、プリンターの自動接続を待つ。",
        "inputSchema": {"type": "object", "properties": PRINT_PROPS},
    },
    {
        "name": "preview_label",
        "description": "印刷せずにラベルの画像（実際に印刷される 1bit のドット）を返す。引数は print_label と同じ。",
        "inputSchema": {"type": "object", "properties": LABEL_PROPS},
    },
    {
        "name": "print_image",
        "description": "画像ファイルを KL-SP100 で印刷する。テープ方向（横）が画像の横、テープ幅方向が画像の縦。"
                       "寸法を合わせたいときは、高さを印字幅にした SVG（mm 単位）を size=fit で渡す。",
        "inputSchema": {"type": "object", "properties": PRINT_IMAGE_PROPS, "required": ["path"]},
    },
    {
        "name": "preview_image",
        "description": "印刷せずに画像ラベルの印字ドットを返す。引数は print_image と同じ。",
        "inputSchema": {"type": "object", "properties": IMAGE_PROPS, "required": ["path"]},
    },
    {
        "name": "printer_status",
        "description": "アプリとプリンターの接続状態、装着テープ幅を返す。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def image_args(args):
    """Replace `path` with the file as a data URL the app can load."""
    path = os.path.expanduser(args.get("path") or "")
    mime = IMAGE_TYPES.get(os.path.splitext(path)[1].lower()) or mimetypes.guess_type(path)[0]
    if not mime or not mime.startswith("image/"):
        raise BridgeError(f"画像ファイルではありません: {path}")
    try:
        if os.path.getsize(path) > MAX_IMAGE_BYTES:
            raise BridgeError("画像ファイルが大きすぎます（10MB まで）")
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
    except OSError as e:
        raise BridgeError(f"画像を読めません: {e}") from e
    out = {k: v for k, v in args.items() if k != "path"}
    out.update(image=f"data:{mime};base64,{data}", name=os.path.basename(path))
    return out


def call_tool(name, args):
    if name == "print_image":
        copies = int(args.get("copies") or 1)
        r = run_job("print_image", image_args(args), timeout=60 + 30 * copies)
        return [{"type": "text", "text": json.dumps(r.get("info", {}), ensure_ascii=False)}]
    if name == "preview_image":
        r = run_job("preview_image", image_args(args), timeout=30)
        png = r["png"].split(",", 1)[1]
        return [
            {"type": "image", "data": png, "mimeType": "image/png"},
            {"type": "text", "text": json.dumps(r.get("info", {}), ensure_ascii=False)},
        ]
    if name == "print_label":
        copies = int(args.get("copies") or 1)
        r = run_job("print", args, timeout=60 + 30 * copies)
        return [{"type": "text", "text": json.dumps(r.get("info", {}), ensure_ascii=False)}]
    if name == "preview_label":
        r = run_job("preview", args, timeout=30)
        png = r["png"].split(",", 1)[1]
        return [
            {"type": "image", "data": png, "mimeType": "image/png"},
            {"type": "text", "text": json.dumps(r.get("info", {}), ensure_ascii=False)},
        ]
    if name == "printer_status":
        r = run_job("status", {}, timeout=30)
        return [{"type": "text", "text": json.dumps(r.get("info", {}), ensure_ascii=False)}]
    raise BridgeError(f"unknown tool: {name}")


# ---------- JSON-RPC over stdio ----------

_send_lock = threading.Lock()


def send(msg):
    with _send_lock:
        sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def handle(msg):
    method, msg_id = msg.get("method"), msg.get("id")
    params = msg.get("params") or {}
    if msg_id is None:
        return   # notification
    if method == "initialize":
        return send({"jsonrpc": "2.0", "id": msg_id, "result": {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
        }})
    if method == "ping":
        return send({"jsonrpc": "2.0", "id": msg_id, "result": {}})
    if method == "tools/list":
        return send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
    if method == "tools/call":
        try:
            content = call_tool(params.get("name"), params.get("arguments") or {})
            result = {"content": content}
        except Exception as e:  # report every failure to the model, never crash
            log(f"{params.get('name')}: {e!r}")
            result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        return send({"jsonrpc": "2.0", "id": msg_id, "result": result})
    send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown method: {method}"}})


def main():
    # serve the app right away so an open tab reconnects without waiting for a tool call
    try:
        status()
    except BridgeError as e:
        log(e)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        # tool calls can take minutes (printing); keep answering pings meanwhile
        threading.Thread(target=handle, args=(msg,), daemon=True).start()


if __name__ == "__main__":
    main()
