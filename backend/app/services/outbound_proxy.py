from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlsplit
from urllib.request import getproxies


def resolve_outbound_proxy() -> str | None:
    """Return an explicitly configured, local HTTP proxy without credentials.

    The project deliberately does not trust arbitrary environment/registry
    proxies. A loopback proxy is accepted because it is controlled by the
    current Windows user and is required for this machine's TikTok access.
    """

    explicit = os.environ.get("TDA_OUTBOUND_PROXY", "").strip()
    candidates = [explicit] if explicit else _system_proxy_candidates()
    for candidate in candidates:
        normalized = normalize_outbound_proxy(candidate)
        if normalized:
            return normalized
    return None


def normalize_outbound_proxy(value: str | None) -> str | None:
    """Normalize a safe proxy URL, rejecting anything except loopback HTTP."""

    return _safe_loopback_proxy(value or "")


def _system_proxy_candidates() -> list[str]:
    try:
        proxies = {str(key).lower(): value for key, value in getproxies().items()}
    except (OSError, ValueError):
        return []
    values = [proxies.get("https"), proxies.get("http"), proxies.get("all")]
    return [value for value in values if isinstance(value, str)]


def _safe_loopback_proxy(value: str) -> str | None:
    if not value or len(value) > 2_048:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or port is None
    ):
        return None
    host = (parsed.hostname or "").rstrip(".").lower()
    if host == "localhost":
        return f"http://localhost:{port}"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    if not address.is_loopback:
        return None
    bracketed = f"[{address}]" if address.version == 6 else str(address)
    return f"http://{bracketed}:{port}"
