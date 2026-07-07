# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

from dreamdex_bot.reports.generate import build_summary


def test_build_summary_includes_core_sections():
    summary = build_summary([
        {
            "event": "bot_starting",
            "category": "startup",
            "network": "testnet",
            "wallet": "0xabc",
            "config_path": "configs/testnet.yaml",
            "started_at": "2026-05-23T00:00:00Z",
        },
        {
            "event": "strategies_configured",
            "category": "startup",
            "markets": ["SOMI:USDso"],
            "strategies": ["volume_mill:SOMI:USDso"],
        },
        {
            "event": "order_submitted",
            "category": "order",
            "market": "SOMI:USDso",
            "notional": "2.50",
            "tx_hash": "0x1",
        },
        {
            "event": "rest_5xx",
            "category": "api",
            "method": "GET",
            "path": "/v0/markets",
            "status": 503,
            "body": "temporary",
        },
    ])

    assert "# DreamDEX Bot Session Report" in summary
    assert "Network: testnet" in summary
    assert "Receipt-confirmed order txs (waited paths only): 0" in summary
    assert "Receipt-confirmed with logs / OrderPlaced evidence: 0" in summary
    assert "volume_mill:SOMI:USDso" in summary
    assert "SOMI:USDso: 2.5 quote notional" in summary
    assert "rest_5xx" in summary
