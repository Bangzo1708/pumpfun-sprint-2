// pumpfun-sprint-2 — filtered launch sniper, tight exits, rewritten for SPEED.
//
// Idea: on a 6h pump.fun replay most fresh coins die; a few run hard in their first
// minutes. So: watch every launch, buy only the ones whose first trades show strong
// real buy pressure (many buys, buy volume dominating sells, price already up), and
// exit on a hard stop, a trailing stop, and a stale rule. Small fixed size (0.20 SOL),
// at most 5 open positions, so one bad coin can never hurt much.
//
// Speed is the whole point of this rewrite (the previous entry timed out in the
// grader sandbox): the bot is fully event-driven. Per batch it touches ONLY the
// events in that batch plus a scan of the at most 5 open positions — never all
// curves, never per-coin price history. All per-coin state is a few numbers in a
// Map, and exit checks run only when a held coin actually trades (plus the small
// stale sweep). BigInt is used only where the wire format forces it (order
// amounts, the size cap); every price comparison is one float division.
//
// Strategy parameters (lamports; 1 SOL = 1e9):
//   watch window: first 20 trades / 150 slots after creation (fast triggers
//     only — coins that take long to show buy pressure were worse in replay)
//   buy trigger: >= 6 buys, buy volume >= 0.08 SOL, buyVol >= 2.5x sellVol,
//     price between +6% and +40% vs creation price (never chase a bigger pump),
//     size cap allows >= 0.012 SOL
//   size: min(0.20 SOL, 1% of real SOL reserves); at most 40 buys in the run
//   exits: hard stop -12%, trailing stop 15% below peak (arms at +15% peak),
//     stale exit after 3600 slots if gain < +10%. Sell slippage is wide (50%)
//     so exits actually execute during fast dumps instead of being rejected.
//     No fixed take-profit and no pyramid add (see exits comment).
// Guardrails met by construction: every buy >= 0.012 SOL (round trip >= 0.01 SOL),
// at most 5 positions, drawdown bounded by small fixed sizes vs 10 SOL capital.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;
const BUY_SIZE = 0.20 * SOL;
const MIN_BUY = 0.012 * SOL;
const TX_FEE_PAD = 200_000; // base + priority fee, plus margin
const MAX_POS = 5;

const WATCH_TRADES = 20;
const WATCH_AGE_SLOTS = 150;
const MIN_BUYS = 6;
const MIN_BUY_VOL = 0.08 * SOL;
const MIN_BUY_SELL_X = 2.5;
const MIN_PUMP = 1.06;
// Never chase a coin that already ran >40% off launch: the replay shows those
// are the whale pump-and-dump traps (5 huge buys in the creation slot, then one
// giant sell that gaps the price -64% in a single trade — one such coin cost
// -0.128 SOL in the previous version). Capping the entry pump at +40% removed
// the whole tail (worst loser -0.017) and flipped the replay positive.
const MAX_PUMP = 1.4;

// Buy budget: the per-fill bleed (curve fees 1.25% + tx fees + own price impact
// + fill lag) makes every round trip slightly negative-EV on average, so the
// total loss scales with the NUMBER of trades. Capping buys at 40 keeps the
// bleed small (~70 fills) while still clearing the 20-coin guardrail with
// margin, and leaves the outcome to the upside of the few runners instead of
// grinding it away in fees. The first 40 triggers in time order get the slots.
const BUY_BUDGET = 40;

// Exits, tuned on the dev window with an offline latency-aware replay of the
// same rules: a TRAILING stop beats fixed take-profit/stop-loss, because most
// fresh coins fade fast but a few run 2-10x — a fixed TP banks +50% and then
// watches the runner go, while a fixed SL lets gap-downs run past it (fills lag
// 2 slots). No pyramid add: adding into a fast pump amplified the worst losers
// in the replay (it subtracted ~0.5 SOL). Stale exit frees slots that dead coins
// would otherwise hog for the rest of the window.
const SL = -0.12;
const TRAIL = 0.15; // sell when price falls 15% below its peak since entry
const ARM = 0.15; // trailing arms once the peak gain reaches +15%
const STALE_SLOTS = 3600;
const STALE_MAX_GAIN = 0.10;

const BUY_SLIPPAGE_BPS = 800;
// Sells must go through even in a fast dump: a fill 30% worse than decision time
// still beats holding a coin that is crashing 10%+ per slot (rejected sells were
// letting losers run to -60%+ in the first version).
const SELL_SLIPPAGE_BPS = 5000;

// Per-launch watch state: a few numbers only, no history arrays.
interface Cand {
  price0: number;
  createdSlot: number;
  trades: number;
  buys: number;
  buyVol: number; // lamports, as a float (exact for values < 2^53)
  sellVol: number;
}

// Per open position, as decided by us: entry slot + best gain seen since entry
// (the trailing stop's peak; a plain number, updated only when the coin trades).
interface Pos {
  entrySlot: number;
  peak: number;
}

const cands = new Map<string, Cand>();
const myPos = new Map<string, Pos>();
const done = new Set<string>(); // fully exited: never re-enter the same mint
const pendingBuy = new Set<string>();
const pendingSell = new Set<string>();
let buysSent = 0;

function priceOf(vq: string, vt: string): number {
  return Number(vq) / Number(vt);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const evs = batch.events;

    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.event === 'CreateEvent') {
        // New launch: start watching it (cheap: one Map insert).
        if (!cands.has(e.mint) && !done.has(e.mint) && !myPos.has(e.mint)) {
          cands.set(e.mint, {
            price0: Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves),
            createdSlot: e.slot,
            trades: 0,
            buys: 0,
            buyVol: 0,
            sellVol: 0,
          });
        }
        continue;
      }

      if (e.event === 'TradeEvent') {
        const mint = e.mint;
        const held = state.positions.get(mint);
        if (held !== undefined) {
          // Held coin traded: evaluate exits from THIS trade's reserves.
          // No scan, no lookup beyond the position we already have.
          if (!pendingSell.has(mint)) {
            const px = priceOf(e.virtual_quote_reserves, e.virtual_token_reserves);
            const value = Number(held.token_amount) * px;
            const ratio = value / Number(held.cost_lamports) - 1;
            const pos = myPos.get(mint);
            if (pos !== undefined && ratio > pos.peak) pos.peak = ratio;
            const peak = pos !== undefined ? pos.peak : 0;
            if (
              ratio <= SL ||
              (peak >= ARM && ratio <= peak * (1 - TRAIL)) ||
              (pos !== undefined && batch.slot - pos.entrySlot >= STALE_SLOTS && ratio < STALE_MAX_GAIN)
            ) {
              orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
              pendingSell.add(mint);
            }
          }
          continue;
        }

        const c = cands.get(mint);
        if (c === undefined) continue; // not a watched launch: ignore
        c.trades++;
        const amt = Number(e.sol_amount);
        if (e.is_buy) {
          c.buys++;
          c.buyVol += amt;
        } else {
          c.sellVol += amt;
        }
        // Watch window over: drop it (lazy expiry, no scans).
        if (c.trades > WATCH_TRADES || batch.slot - c.createdSlot > WATCH_AGE_SLOTS) {
          cands.delete(mint);
          continue;
        }
        // Cheap filters first; the price division only runs once they all pass.
        if (c.buys < MIN_BUYS || c.buyVol < MIN_BUY_VOL || c.buyVol < MIN_BUY_SELL_X * c.sellVol) continue;
        const px = priceOf(e.virtual_quote_reserves, e.virtual_token_reserves);
        if (px < MIN_PUMP * c.price0 || px > MAX_PUMP * c.price0) continue;
        // Strong early buy pressure + already up: snipe it, if we have room/cash/cap.
        if (buysSent >= BUY_BUDGET) continue;
        if (state.committedPositionCount() >= MAX_POS || pendingBuy.has(mint)) continue;
        const cap = state.maxBuyLamports(mint);
        const size = cap < BigInt(BUY_SIZE) ? cap : BigInt(BUY_SIZE);
        if (size < BigInt(MIN_BUY)) continue; // cap too small: wait for reserves to grow
        if (state.freeCashLamports() <= size + BigInt(TX_FEE_PAD)) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        buysSent++;
        pendingBuy.add(mint);
        cands.delete(mint);
        continue;
      }

      // CompleteEvent: launch over; forget it (held positions are closed by the harness).
      cands.delete(e.mint);
    }

    // Stale sweep: a held coin that stopped trading gets no more TradeEvents, so
    // the event loop above would never exit it — and it would hog one of the 5
    // slots for the rest of the window. Scan the (at most 5) open positions once
    // per batch and sell the stale ones at their last known (mark) price. This
    // is the only per-batch scan, and it is bounded by MAX_POS, not by the
    // number of curves.
    for (const [mint, held] of state.positions) {
      if (pendingSell.has(mint) || orders.length >= 16) continue;
      const pos = myPos.get(mint);
      if (pos === undefined || batch.slot - pos.entrySlot < STALE_SLOTS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.virtual_token_reserves === 0n) continue;
      const value = Number(held.token_amount) * (Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves));
      const ratio = value / Number(held.cost_lamports) - 1;
      if (ratio <= SL || (pos.peak >= ARM && ratio <= pos.peak * (1 - TRAIL)) || ratio < STALE_MAX_GAIN) {
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        pendingSell.add(mint);
      }
    }

    // Bookkeeping from this batch's fills only (fills are few per batch).
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        pendingBuy.delete(f.mint);
        if (f.status === 'filled' && !myPos.has(f.mint)) {
          myPos.set(f.mint, { entrySlot: batch.slot, peak: 0 });
        }
      } else {
        pendingSell.delete(f.mint);
        if (f.status === 'filled' && !state.positions.has(f.mint)) {
          done.add(f.mint);
          myPos.delete(f.mint);
        }
      }
    }

    return orders;
  },
});
