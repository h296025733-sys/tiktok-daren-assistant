from __future__ import annotations

import pytest

from app.services import outbound_proxy


def test_explicit_loopback_http_proxy_takes_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TDA_OUTBOUND_PROXY", "http://127.0.0.1:9567")
    monkeypatch.setattr(
        outbound_proxy,
        "getproxies",
        lambda: {"https": "http://127.0.0.1:8118"},
    )

    assert outbound_proxy.resolve_outbound_proxy() == "http://127.0.0.1:9567"


def test_wininet_loopback_proxy_is_used_when_explicit_value_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TDA_OUTBOUND_PROXY", raising=False)
    monkeypatch.setattr(
        outbound_proxy,
        "getproxies",
        lambda: {"https": "http://localhost:9567"},
    )

    assert outbound_proxy.resolve_outbound_proxy() == "http://localhost:9567"


@pytest.mark.parametrize(
    "value",
    [
        "https://127.0.0.1:9567",
        "socks5://127.0.0.1:9567",
        "http://192.0.2.10:9567",
        "http://user:password@127.0.0.1:9567",
        "http://127.0.0.1:9567/proxy",
        "http://127.0.0.1",
    ],
)
def test_unsafe_proxy_values_are_rejected(value: str) -> None:
    assert outbound_proxy.normalize_outbound_proxy(value) is None


def test_invalid_explicit_proxy_does_not_fall_back_to_wininet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TDA_OUTBOUND_PROXY", "http://remote.example:8080")
    monkeypatch.setattr(
        outbound_proxy,
        "getproxies",
        lambda: {"https": "http://127.0.0.1:9567"},
    )

    assert outbound_proxy.resolve_outbound_proxy() is None
