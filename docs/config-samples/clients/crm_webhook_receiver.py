"""A CRM endpoint for the webhook `mcp start -w <url>` / `listen -w <url>` sends. Python 3, standard library only.

    WEBHOOK_SECRET=... python crm_webhook_receiver.py

The sender does not retry and gives a delivery 5 seconds, so: verify the signature over the RAW body,
answer 2xx at once and work afterwards, and de-duplicate on the message id.
"""
import hashlib
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ.get("WEBHOOK_SECRET", "")
SEEN = set()  # use your database in production


def verify_webhook(raw_body: bytes, headers, secret: str) -> bool:
    """Check `X-Zalo-Signature: sha256=<hex hmac of the body>`."""
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(headers.get("X-Zalo-Signature", ""), expected)


def handle(event: dict) -> None:
    print("message", event.get("id") or event.get("msgId"), event.get("threadId"))


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not verify_webhook(raw, self.headers, SECRET):
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)  # acknowledge first
        self.end_headers()
        self.wfile.write(b"ok")
        event = json.loads(raw)
        key = (event.get("accountId"), event.get("id") or event.get("msgId"))
        if key[1] is not None and key in SEEN:
            return
        SEEN.add(key)
        threading.Thread(target=handle, args=(event,), daemon=True).start()

    def log_message(self, *args):  # keep the access log quiet
        pass


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("set WEBHOOK_SECRET")
    HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Hook).serve_forever()
