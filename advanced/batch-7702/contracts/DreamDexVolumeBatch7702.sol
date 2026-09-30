// SPDX-License-Identifier: MIT
/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

pragma solidity ^0.8.20;

/// @notice The slice of the DreamDEX SpotPool this batcher uses. `placeOrder` is
///         the modern, post-June-2026-upgrade entry point (payable, wallet auto-pull).
interface ISpotPool {
    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title DreamDexVolumeBatch7702
/// @notice Implementation bytecode delegated onto an EOA via EIP-7702. When
///         invoked through delegation, `address(this)` IS the funded wallet, so a
///         full buy -> sell round-trip happens in a SINGLE transaction — two fills
///         per tx instead of one.
///
///         Design: this uses the modern WALLET auto-pull / auto-deliver model (no
///         vault). The IOC buy pulls quote from the wallet and delivers the base
///         back to the wallet; we then IOC-sell exactly the base we received.
///         Selling the *realized* amount (measured by balance delta) is the fix
///         for partial fills — selling a fixed size would revert the whole batch.
contract DreamDexVolumeBatch7702 {
    uint8 internal constant ORDER_IOC = 2;
    uint8 internal constant SELF_MATCH_CANCEL_TAKER = 0;

    event RoundTrip(address indexed pool, uint256 boughtBase, uint256 buyPrice, uint256 sellPrice);

    /// @dev A 7702 delegation stays on the account until it is replaced or cleared, so this code
    ///      keeps answering calls long after the batch that installed it. Every entry point is
    ///      therefore restricted to the wallet itself: under delegation the wallet's own call
    ///      arrives with `msg.sender == address(this)`, and nobody else's does. Without this,
    ///      any stranger could call a delegated wallet with a `pool` of their own and have the
    ///      wallet approve it for the wallet's tokens.
    modifier onlySelf() {
        require(msg.sender == address(this), "only self");
        _;
    }

    /// @notice ERC-20 base pair: IOC buy, then IOC sell exactly what the buy
    ///         acquired. Requires an ERC-20 base (use a pegged pair like
    ///         USDC.e:USDso to keep the round-trip near flat).
    function atomicRoundTrip(
        address pool,
        address quoteToken,
        address baseToken,
        uint256 buyPrice,
        uint256 sellPrice,
        uint256 quantity,
        uint64 expireTimestampNs
    ) external onlySelf {
        require(quantity > 0 && buyPrice > 0 && sellPrice > 0, "bad args");

        // Each approval is granted for the leg that needs it and taken back in the same
        // transaction, so the batch leaves no standing allowance behind.
        uint256 baseBefore = IERC20(baseToken).balanceOf(address(this));

        IERC20(quoteToken).approve(pool, type(uint256).max);
        _placeIoc(pool, true, buyPrice, quantity, expireTimestampNs);
        IERC20(quoteToken).approve(pool, 0);

        uint256 bought = IERC20(baseToken).balanceOf(address(this)) - baseBefore;

        if (bought > 0) {
            IERC20(baseToken).approve(pool, type(uint256).max);
            _placeIoc(pool, false, sellPrice, bought, expireTimestampNs);
            IERC20(baseToken).approve(pool, 0);
        }
        emit RoundTrip(pool, bought, buyPrice, sellPrice);
    }

    function _placeIoc(address pool, bool isBid, uint256 price, uint256 qty, uint64 expireTimestampNs) private {
        (bool ok,) = ISpotPool(pool).placeOrder(
            isBid, 0, price, qty, expireTimestampNs, ORDER_IOC, SELF_MATCH_CANCEL_TAKER, address(0), 0
        );
        require(ok, isBid ? "buy rejected" : "sell rejected");
    }

    // Accept native proceeds if the pool ever delivers them (e.g. native pairs).
    receive() external payable {}
}
