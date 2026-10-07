# Perps

The `perp-*` strategies trade DreamDEX perpetual futures. They run on the **Hideki
testnet** (chain 50383), where the [DreamDEX testnet app](https://app.testnet.dreamdex.io)
and Perps Arena live. Mainnet has no perp markets, so `NETWORK=mainnet` is refused at
startup.

| Strategy | What it does |
| --- | --- |
| [perp-starter](../strategies/perp-starter) | Opens one position and closes it at a take-profit or stop-loss. |
| [perp-maker](../strategies/perp-maker) | Rests a bid and an ask around the mark and skews them to stay flat. |
| [perp-funding](../strategies/perp-funding) | Holds whichever side funding pays, and steps aside when the rate drops. |
| [perp-guard](../strategies/perp-guard) | Not a trader: trims or closes positions as margin health falls. |

Run `npm run perp:doctor` first. It lists the markets, their live marks and books, and
says whether your key is ready to trade.

## Trade your DreamDEX account with a trading key

You do not hand the bot your account's key. You give the bot a key of its own and link
it to your account in the app. The bot can then place, cancel and reduce orders for
your account, and every fill lands in your account. It cannot withdraw or send funds.

1. **Make a bot key.** Any new EOA works, for example `cast wallet new`. Keep it apart
   from your account's own key.
2. **Link it.** In the app, open your wallet and choose **Link a bot**. Paste the bot's
   address, keep **Perps** ticked, and press **Add bot**. The bot pays for its own
   orders in STT; the same screen can offer to send it some, or send STT to its
   address yourself.
3. **Fund perps margin.** Perps orders only use margin that is already in your Perps
   account. On the perps page, open **Perps ⇆ Spot**, move USDso from **Spot wallet**
   to **Perps account**.
4. **Run the bot** with the bot key as `PRIVATE_KEY` and your account as
   `OWNER_ADDRESS`:

```bash
NETWORK=hideki
PRIVATE_KEY=0x...
OWNER_ADDRESS=0x...
STRATEGY=perp-starter
PERP_SYMBOL=ETH-PERP
PERP_NOTIONAL_USDSO=20
DRY_RUN=true
```

`STRATEGY` is only read on Railway; locally, run `npm start -w perp-starter`. Read the
dry-run logs first, then set `DRY_RUN=false`.

At startup each strategy checks the link and exits with a message if the bot key
cannot trade that market for your account.

What a trading key cannot do, and how the strategies handle it:

- **Leverage** is your account's setting. The bot reads it and leaves it alone; change
  it in the app.
- **Stop orders** can only be armed by the account itself. perp-starter therefore
  watches its take-profit and stop-loss and closes the position when the mark crosses
  one. That only works while the bot is running.
- **Margin** is not pulled from your spot wallet automatically. Move it to Perps first
  (step 3).

Leave `OWNER_ADDRESS` blank to trade the key's own perps account instead. That key then
needs USDso in its own MarginBank and STT for gas. In that mode perp-starter arms real
stop orders, and each one locks a small STT deposit until it fires or is cancelled.

## On Railway

Use the same template as the other strategies (see [railway.md](railway.md)) and paste
the block above into **Variables → RAW Editor** with your bot key. A `perp-*` service
with no `NETWORK` of its own runs on Hideki; the baked defaults are for the spot bots.
