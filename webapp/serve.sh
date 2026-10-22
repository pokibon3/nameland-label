#!/bin/sh
# Serve the KL-SP100 label app on localhost and open it in Chrome.
# WebUSB/Web Bluetooth needs Chrome/Edge and a secure context (localhost is fine).
PORT="${1:-8123}"
cd "$(dirname "$0")" || exit 1

URL="http://localhost:$PORT"
echo "$URL で起動します（Ctrl+C で停止）"
(sleep 1; open -a "Google Chrome" "$URL?v=1.1.12" 2>/dev/null || open "$URL?v=1.1.12") &
exec python3 server.py "$PORT"
