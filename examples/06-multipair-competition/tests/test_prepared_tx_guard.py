# python3 tests/test_prepared_tx_guard.py  (standard library only, no dependencies needed)
import importlib.util
import pathlib
import unittest

_spec = importlib.util.spec_from_file_location("prepared_tx_guard", pathlib.Path(__file__).resolve().parent.parent / "bot" / "prepared_tx_guard.py")
g = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g)

POOL = "0xa936da11B57b50A344e1293AAaE5232885ea2bDE"
OTHER = "0x1111111111111111111111111111111111111111"


def pad(h):
    return h.replace("0x", "").lower().rjust(64, "0")


def order_with(builder, fee):
    return g.SELECTORS["placeOrder"] + pad("0x1") * 7 + pad(builder) + pad(fee)


ORDER = order_with("0x0", "0x0")
CANCEL = g.SELECTORS["cancelOrder"] + pad("0x2a")
OPTS = dict(allow=(g.SELECTORS["placeOrder"], g.SELECTORS["cancelOrder"]), chain_id=5031,
            is_known_pool=lambda a: a == POOL)


class PreparedTxGuard(unittest.TestCase):
    def test_accepts_an_expected_order_call(self):
        out = g.check_prepared_tx({"to": POOL, "data": ORDER, "value": "0", "chainId": 5031}, **OPTS)
        self.assertEqual(out, {"to": POOL, "data": ORDER, "value": 0})
        self.assertEqual(g.check_prepared_tx({"to": POOL, "data": bytes.fromhex(CANCEL[2:])}, **OPTS)["data"], CANCEL)

    def test_refuses_a_transfer_an_approval_and_a_coin_send(self):
        for tx in ({"to": POOL, "data": "0xa9059cbb" + pad(OTHER) + pad("0x1")},
                   {"to": POOL, "data": "0x095ea7b3" + pad(OTHER) + pad("0x1")},
                   {"to": OTHER, "data": "0x", "value": "1"}):
            with self.assertRaises(g.PreparedTxRejected):
                g.check_prepared_tx(tx, **OPTS)

    def test_refuses_coin_with_a_call_that_takes_none(self):
        with self.assertRaises(g.PreparedTxRejected):
            g.check_prepared_tx({"to": POOL, "data": CANCEL, "value": 1}, **OPTS)

    def test_native_coin_only_to_an_official_pool(self):
        self.assertEqual(g.check_prepared_tx({"to": POOL, "data": ORDER, "value": "0x5"}, **OPTS)["value"], 5)
        with self.assertRaises(g.PreparedTxRejected):
            g.check_prepared_tx({"to": OTHER, "data": ORDER, "value": 5}, **OPTS)

    def test_refuses_an_expected_call_to_a_contract_that_is_not_an_official_pool(self):
        for data in (ORDER, CANCEL):
            with self.assertRaises(g.PreparedTxRejected):
                g.check_prepared_tx({"to": OTHER, "data": data}, **OPTS)

    def test_refuses_an_order_that_names_a_builder_or_a_builder_fee(self):
        for data in (order_with(OTHER, "0x0"), order_with("0x0", "0x64"), ORDER[:200]):
            with self.assertRaises(g.PreparedTxRejected):
                g.check_prepared_tx({"to": POOL, "data": data}, **OPTS)

    def test_refuses_another_chain_and_malformed_input(self):
        for tx in ({"to": POOL, "data": ORDER, "chainId": 1},
                   {"to": "pool", "data": ORDER},
                   {"to": POOL, "data": "0x4e97"}):
            with self.assertRaises(g.PreparedTxRejected):
                g.check_prepared_tx(tx, **OPTS)

    def test_approval_only_for_the_expected_spender(self):
        approve = g.SELECTORS["approve"] + pad(POOL) + pad("0xff")
        opts = dict(OPTS, allow=(g.SELECTORS["approve"],))
        self.assertEqual(g.check_prepared_tx({"to": OTHER, "data": approve}, approve_spender=POOL, **opts)["data"], approve)
        with self.assertRaises(g.PreparedTxRejected):
            g.check_prepared_tx({"to": OTHER, "data": approve}, approve_spender=OTHER, **opts)
        with self.assertRaises(g.PreparedTxRejected):
            g.check_prepared_tx({"to": OTHER, "data": approve}, **opts)

    def test_registry_lookups(self):
        calls = []
        yes = lambda tx: (calls.append(tx), bytes.fromhex(pad("0x1")))[1]
        no = lambda tx: "0x" + pad("0x0")
        fresh = "0x2222222222222222222222222222222222222222"
        self.assertTrue(g.registry_pool_check(yes, 5031)(fresh))
        self.assertTrue(g.registry_pool_check(yes, 5031)(fresh))
        self.assertEqual(calls, [{"to": g.POOL_REGISTRY[5031], "data": "0xc3c5a547" + pad(fresh)}])
        self.assertFalse(g.registry_pool_check(yes, 999)(POOL))
        self.assertEqual(g.require_official_pool(yes, 50312, POOL), POOL)
        with self.assertRaises(g.PreparedTxRejected):
            g.require_official_pool(no, 5031, OTHER)
        with self.assertRaises(g.PreparedTxRejected):
            g.require_official_pool(yes, 5031, "not-an-address")


if __name__ == "__main__":
    unittest.main()
