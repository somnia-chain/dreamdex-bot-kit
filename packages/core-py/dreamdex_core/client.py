# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Chain client: web3 + local account for the active network."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv
from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import Web3

from .config import Network, get_network

load_dotenv()


@dataclass
class ChainContext:
    net: Network
    w3: Web3
    account: LocalAccount

    @property
    def address(self) -> str:
        return self.account.address


def create_chain_context(private_key: str | None = None) -> ChainContext:
    net = get_network()
    key = private_key or os.environ.get("PRIVATE_KEY")
    if not key:
        raise RuntimeError("Set PRIVATE_KEY (env) or pass one to create_chain_context().")
    if not key.startswith("0x"):
        key = "0x" + key
    account: LocalAccount = Account.from_key(key)
    w3 = Web3(Web3.HTTPProvider(net.rpc_url))
    return ChainContext(net=net, w3=w3, account=account)
