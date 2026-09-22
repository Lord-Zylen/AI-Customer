"""Mirror gateway turns into the Customer AI app. Installed by the app; stdlib only.

Requires CAI_HOOK_SECRET in the environment (the same shared secret the Customer AI
server validates). Without it, events are skipped so the gateway behaves unchanged.

Failures are logged (class/HTTP status/timeout only) but never break the pipeline and
never include secrets, message contents, or the integration base URL.
"""

import json
import logging
import os
import urllib.request

logger = logging.getLogger("customer-ai-tap")

BASE_URL = os.environ.get("CAI_HOOK_BASE_URL", "http://127.0.0.1:5000").rstrip("/")
SECRET = os.environ.get("CAI_HOOK_SECRET", "") or ""
TIMEOUT = 3


def _error_summary(exc):
    parts = [exc.__class__.__name__]
    code = getattr(exc, "code", None)
    if code is not None:
        parts.append(f"HTTP {code}")
    reason = getattr(exc, "reason", None)
    if isinstance(exc, (TimeoutError, OSError)) or exc.__class__.__name__ == "socket.timeout":
        parts.append("timeout")
    elif reason is not None and reason.__class__.__name__ == "socket.timeout":
        parts.append("timeout")
    return " ".join(parts)


def handle(event_type, context):
    if event_type not in ("agent:start", "agent:end"):
        return
    if not SECRET:
        return
    if (context.get("platform") or "") != "whatsapp":
        return
    try:
        payload = {"event": event_type, "ts": context.get("ts") or None,
                   "platform": context.get("platform") or "", "user_id": context.get("user_id") or "",
                   "user_name": context.get("user_name") or "", "chat_id": context.get("chat_id") or "",
                   "thread_id": context.get("thread_id") or "", "chat_type": context.get("chat_type") or "",
                   "session_id": context.get("session_id") or "",
                   "message": context.get("message") or "", "response": context.get("response") or "",
                   "model": context.get("model") or "", "provider": context.get("provider") or ""}
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(f"{BASE_URL}/api/hermes/webhook/event", data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("x-cai-hook-secret", SECRET)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            resp.read()
    except Exception as exc:  # noqa: BLE001 — hooks must never break the gateway pipeline.
        logger.warning("customer-ai-tap: mirror hook failed: %s", _error_summary(exc))