// Pump Sprint: 12-Hour Paper Trading Dash — "Dip-and-Ride Sniper".
//
// Idea: most new pump.fun coins die within minutes, so the bot only ever
// risks a small fixed stake per coin, only after the coin proves somebody
// is actually buying it (price up 10% from where it was first seen, with
// real SOL already in the curve), and it exits fast: a hard stop, a
// take-profit ladder, a trailing stop once a winner runs, and a hard time
// limit so dead money never sits. One buy per coin, never a re-entry, so
// no single coin can bleed the book twice.
//
// Mechanics (pumpfun-replay/v2, hello / batch / orders / slot):
//   - runBot delivers a hello (capital, caps, fees, latency_slots) then one
//     batch per slot: events (Create/Trade/Complete), marks (latest
//     reserves), fills (how earlier orders resolved) and the account.
//   - Orders decided on the batch for slot s fill at slot s + latency.
//   - A buy may spend at most caps.max_order_bps_of_real_reserve (100 bps
//     = 1%) of the mint's real SOL reserves, so the stake is capped by the
//     curve's size at decision time; state.maxBuyLamports(mint) gives it.
//   - A sell must be chunked: dumping a whole position at once drains the
//     curve's real SOL to ~0 and the fill is refused forever, so each sell
//     order is sized so its expected SOL is at most 40% of the curve's
//     real SOL reserves. A sell whose expected proceeds would not cover
//     its own transaction fee is skipped (the harness would write it off).
//   - Price of a mint = virtual_quote_reserves / virtual_token_reserves
//     (SOL per token). Entry price is the position's cost basis
//     (cost_lamports / token_amount, fees included), so the stops are
//     measured against what was really paid.
//   - Fully deterministic: no clock, no randomness, insertion-ordered maps
//     only, so the grader's two runs produce byte-identical action logs.
//
// Guardrails: at least 20 distinct coins with round trips of >= 0.01 SOL
// each, max drawdown <= 50%. With a 0.03 SOL stake and 10 SOL of capital
// the book can work through hundreds of coins in the window, so the
// 20-coin bar is met by breadth, not by forcing trades.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type Batch,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL the bot wants in each new coin (the 1%-of-real-reserves cap binds first). */
const STAKE_SOL = 0.03;
/** Real SOL a curve must hold before it is buyable at all. */
const MIN_REAL_SOL = 0.5;
/** Price must be up this much from the first price seen to confirm buyers. */
const ENTRY_RISE = 0.10;
/** At least this many trades seen on the curve before buying. */
const MIN_TRADES = 3;
/** Sell everything when the price falls this far below the entry price. */
const STOP_LOSS = 0.10;
/** At this gain, sell half the position and let the rest ride. */
const TAKE_PROFIT = 0.30;
/** Once the peak gain reaches this, arm the trailing stop. */
const TRAIL_ARM = 0.15;
/** Sell everything when the price gives back this much from its peak. */
const TRAIL_GIVEBACK = 0.20;
/** Sell everything after this many slots held, winner or not. */
const MAX_HOLD_SLOTS = 900;
/** One sell order takes at most this share of the curve's real SOL. */
const MAX_SELL_SHARE_OF_REAL = 0.40;
/** Skip a sell whose expected SOL is below this many tx fees. */
const MIN_SELL_TX_FEES = 3;
/** Wide slippage so a fill is never refused for the 2-slot latency move. */
const SLIPPAGE_BPS = 10_000;

const SOL = 1_000_000_000n;
const STAKE_LAMPORTS = BigInt(Math.round(STAKE_SOL * 1_000_000_000));
const MIN_REAL_LAMPORTS = BigInt(Math.round(MIN_REAL_SOL * 1_000_000_000));

// ------------------------------------------------------------------ helpers

/** SOL per token from a curve's virtual reserves, as a plain number. */
function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vt = curve.virtual_token_reserves;
  if (vt <= 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(vt);
}

/** Tokens worth `quoteLamports` SOL at `price` SOL per token. */
function tokensForQuote(quoteLamports: bigint, price: number): bigint {
  if (price <= 0) return 0n;
  return BigInt(Math.floor(Number(quoteLamports) / price));
}

// ------------------------------------------------------------------ tracking

interface CoinWatch {
  /** Price the first time this mint was seen. */
  firstPrice: number;
  /** Highest price seen since the position opened (0 while flat). */
  peak: number;
  /** Slot the position was first seen in the account. */
  heldSinceSlot: number;
  /** Whether the take-profit half has already been sold. */
  tookHalf: boolean;
}

const watched = new Map<string, CoinWatch>();
/** Mints already bought once (never re-entered). */
const entered = new Set<string>();

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- notice new coins, in event order ---------------------------------
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') {
        watched.delete(e.mint);
        continue;
      }
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const w = watched.get(e.mint);
      if (w === undefined) {
        const p = priceOf(curve);
        if (p > 0) watched.set(e.mint, { firstPrice: p, peak: 0, heldSinceSlot: -1, tookHalf: false });
      }
    }

    // --- exits first: manage what is already held -------------------------
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve);
      if (price <= 0 || holding.token_amount <= 0n) continue;
      const entryPrice = Number(holding.cost_lamports) / Number(holding.token_amount);
      if (entryPrice <= 0) continue;

      const w = watched.get(mint) ?? { firstPrice: entryPrice, peak: entryPrice, heldSinceSlot: state.slot, tookHalf: false };
      if (!watched.has(mint)) watched.set(mint, w);
      if (w.heldSinceSlot < 0) w.heldSinceSlot = state.slot;
      if (price > w.peak) w.peak = price;

      const gain = price / entryPrice - 1;
      const peakGain = w.peak / entryPrice - 1;
      const heldSlots = state.slot - w.heldSinceSlot;

      let sellTokens = 0n;
      if (gain <= -STOP_LOSS) {
        sellTokens = holding.token_amount; // hard stop
      } else if (!w.tookHalf && gain >= TAKE_PROFIT) {
        sellTokens = holding.token_amount / 2n; // bank half
        w.tookHalf = true;
      } else if (peakGain >= TRAIL_ARM && price <= w.peak * (1 - TRAIL_GIVEBACK)) {
        sellTokens = holding.token_amount; // trailing stop
      } else if (heldSlots >= MAX_HOLD_SLOTS) {
        sellTokens = holding.token_amount; // time limit
      }
      if (sellTokens <= 0n) continue;

      // Chunk the sell: one order takes at most 40% of the real SOL.
      const realQuote = curve.real_quote_reserves;
      const maxQuote = (realQuote * BigInt(Math.round(MAX_SELL_SHARE_OF_REAL * 100))) / 100n;
      const chunkTokens = tokensForQuote(maxQuote, price);
      if (chunkTokens > 0n && chunkTokens < sellTokens) sellTokens = chunkTokens;
      if (sellTokens <= 0n) continue;

      // Skip dust the harness would write off instead of filling.
      const expectedQuote = BigInt(Math.floor(Number(sellTokens) * price));
      if (expectedQuote < txFee * BigInt(MIN_SELL_TX_FEES) && sellTokens < holding.token_amount) continue;

      orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SLIPPAGE_BPS });
      if (sellTokens >= holding.token_amount) watched.delete(mint);
    }

    // --- entries: buy a coin once, only after buyers prove themselves -----
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (entered.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_LAMPORTS) continue;
      if (curve.trades < MIN_TRADES) continue;
      const w = watched.get(mint);
      if (w === undefined) continue;
      const price = priceOf(curve);
      if (price <= 0 || price < w.firstPrice * (1 + ENTRY_RISE)) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < LAMPORTS_PER_SOL / 200n) continue; // under 0.005 SOL: not worth a slot
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + txFee) continue;

      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      entered.add(mint);
      free -= amount + txFee;
      slots -= 1;
    }

    return orders;
  },
});
