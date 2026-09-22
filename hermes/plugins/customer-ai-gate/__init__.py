"""Customer AI gate plugin.

Fires on ``pre_gateway_dispatch`` (supported plugin surface, runs BEFORE gateway auth):

* whatsapp messages → POST the inbound to the Customer AI decision webhook;
  - ``{"action":"skip"}`` → drop the message (no Hermes reply; flagged for humans);
  - otherwise → mark the source authorized so the Hermes agent replies once;
  - Customer AI unreachable/integration off → no admission (default-deny persists),
    so the running setup behaves exactly as before.

Also registers a system-prompt section that loads the approved business knowledge
from Customer AI, so automatic replies stay within known business facts.

Environment (never hard-coded):
  CAI_HOOK_BASE_URL   default http://127.0.0.1:5000
  CAI_HOOK_SECRET     shared secret; absent => integration is OFF (no gating)
  CAI_HOOK_TIMEOUT    seconds, default 4.0
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request

logger = logging.getLogger(__name__)

_BASE_URL = os.environ.get("CAI_HOOK_BASE_URL", "http://127.0.0.1:5000").rstrip("/")
_SECRET = os.environ.get("CAI_HOOK_SECRET", "") or ""
_TIMEOUT = float(os.environ.get("CAI_HOOK_TIMEOUT", "4.0") or 4.0)
_HOME_CHAT = (os.environ.get("WHATSAPP_HOME_CHANNEL", "") or "").strip()

_KNOWLEDGE_CACHE = {"at": 0.0, "text": None}
_KNOWLEDGE_TTL = 300.0

_SAFE_FALLBACK = (
    "Customer AI business knowledge is unavailable. Do not invent business-specific information. "
    "If the customer asks for prices, stock, delivery fees, payment terms, refunds, order status, "
    "policies, or other business-specific information, tell the customer that a human "
    "representative will assist."
)


def _error_summary(exc):
    """Safe failure summary: exception class, HTTP status, timeout flag. Never secrets/content."""
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


def _home_chat_id():
    if _HOME_CHAT:
        return _HOME_CHAT
    try:
        from hermes_cli.config import load_gateway_config
        from gateway.config import Platform
        cfg = load_gateway_config()
        home = cfg.get_home_channel(Platform.WHATSAPP)
        if home is not None and home.chat_id:
            return home.chat_id
    except Exception:
        pass
    return None


def _post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(_BASE_URL + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-cai-hook-secret", _SECRET)
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.status, resp.read()


def on_pre_gateway_dispatch(event, **_kwargs):
    """Return ``{"action":"skip", ...}`` to drop; None to dispatch normally.

    Only whatsapp and only when the integration is configured; the home-channel
    operator chat and non-text messages pass through untouched. Never raises into
    the gateway pipeline and never logs secrets.
    """
    if not _SECRET:
        return None  # integration off: unchanged gateway behavior
    source = getattr(event, "source", None)
    platform = getattr(getattr(source, "platform", None), "value", "") or ""
    if platform != "whatsapp":
        return None
    chat_id = getattr(source, "chat_id", None)
    if not chat_id:
        return None
    if chat_id == _home_chat_id():
        # Security boundary (required): the Hermes home channel is the operator's own
        # WhatsApp account. Operator traffic is never routed through the Customer AI
        # gate and is deliberately NOT recorded as a customer conversation. Customer
        # testing must always use a second, non-home WhatsApp number.
        return None

    try:
        status, body = _post("/api/hermes/webhook/gate", {
            "platform": "whatsapp",
            "chat_id": chat_id,
            "user_id": getattr(event, "user_id", None) or getattr(source, "user_id", None),
            "user_name": getattr(event, "user_name", None) or getattr(source, "user_name", None),
            "message": getattr(event, "text", "") or "",
            "message_id": getattr(event, "message_id", None),
            "media_urls": list(getattr(event, "media_urls", None) or []),
            "media_types": list(getattr(event, "media_types", None) or []),
        })
        if status != 200:
            # Fail closed: default deny still applies. Log so operators can see
            # the gate is rejecting traffic (status + short server reason only —
            # never message contents, secrets, or chat ids).
            try:
                decision = json.loads(body.decode("utf-8") or "{}")
                reason = (decision.get("error") or {}).get("message") or decision.get("reason") or ""
                reason = (" " + str(reason).strip()[:160]) if reason else ""
            except Exception:
                reason = ""
            logger.warning("customer-ai-gate: gate returned HTTP %s%s; message not admitted (fail closed)", status, reason)
            return None
        decision = json.loads(body.decode("utf-8") or "{}")
        if decision.get("action") == "skip":
            return {"action": "skip", "reason": decision.get("reason") or "human handling required"}
        # Explicit Customer AI approval: admit this single message to the agent.
        try:
            event.source.role_authorized = True
        except Exception:
            pass
        return None
    except Exception as exc:  # noqa: BLE001 — hooks must never break the pipeline
        logger.warning("customer-ai-gate: gate call failed (%s); message not admitted", _error_summary(exc))
        return None


def _knowledge_section(_session_info):
    """Approved business knowledge for the agent's system prompt, cached briefly."""
    if not _SECRET:
        return _SAFE_FALLBACK
    now = time.monotonic()
    cached = _KNOWLEDGE_CACHE.get("text")
    if cached is not None and now - _KNOWLEDGE_CACHE.get("at", 0.0) < _KNOWLEDGE_TTL:
        return cached
    try:
        import urllib.request as _urllib
        req = _urllib.Request(_BASE_URL + "/api/hermes/webhook/knowledge", method="GET")
        req.add_header("x-cai-hook-secret", _SECRET)
        with _urllib.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
        settings = data.get("settings") or {}
        parts = []
        if isinstance(settings, dict):
            for key, value in settings.items():
                if key.startswith("_") or not isinstance(value, (str, int, float)):
                    continue
                if value not in (None, "", 0):
                    parts.append(f"- {key}: {value}")
        if parts:
            text = (
                "Authorized business knowledge (Customer AI):\n"
                + "\n".join(parts)
                + "\nRules: only use the knowledge above. NEVER invent prices, stock quantities, "
                  "delivery fees, payment terms, refunds, order status, or policies. If the answer "
                  "is not fully covered here, reply that a human representative will assist."
            )
        else:
            text = _SAFE_FALLBACK
    except Exception as exc:  # noqa: BLE001
        logger.warning("customer-ai-gate: knowledge fetch failed (%s); using safe fallback", _error_summary(exc))
        text = _SAFE_FALLBACK
    _KNOWLEDGE_CACHE["text"] = text
    _KNOWLEDGE_CACHE["at"] = time.monotonic()
    return text


def register(ctx):
    """Plugin entry point (called once by the plugin loader)."""
    ctx.register_hook("pre_gateway_dispatch", on_pre_gateway_dispatch)
    try:
        ctx.register_system_prompt_section(
            "customer-ai-policy", _knowledge_section, position="after_memory", max_chars=4000)
    except Exception as exc:  # noqa: BLE001 — section is best-effort; the gate still works
        logger.warning("customer-ai-gate: failed to register prompt section: %s", exc)