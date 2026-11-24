// Paper Sprint: momentum rider for the pump.fun bonding-curve replay.
//
// Idea: most new pump.fun curves are noise. The ones worth riding show real,
// broad-based buy pressure over a short window: several distinct wallets
// buying, net SOL flowing in and accelerating, price climbing and holding
// near its window high. We enter small, add only into strength, and exit on
// a stop loss, a trailing stop, a fade in flow, or a hard time limit.
//
// A pacing probe keeps the run above the guardrail bar (round trips of at
// least 0.01 SOL on at least 20 coins): when filled orders or distinct coins
// lag the pace set in block time, the bot opens a tiny 0.02 SOL probe round
// trip on a liquid recent curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no environment
// reads; iteration only over insertion-ordered maps fed by the batch stream.

import { runBot, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee (protocol 95 bps + creator 30 bps) used when valuing a position.
const CURVE_FEE = 0.0125;

// ---- tunables -------------------------------------------------------------
const WINDOW = 40; // entry window, slots
const MIN_NET_SOL = 0.8; // net buy SOL over the window
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 4; // distinct buying wallets in the window
const MIN_UP = 0.04; // price now vs window start, minus 1
const MAX_UP = 1.2; // skip curves that already ran too far in one window
const NEAR_HIGH = 0.96; // price now at least this share of the window high
const MIN_RQ_SOL = 1; // real SOL bounds at entry
const MAX_RQ_SOL = 80;
const MIN_AGE = 240; // slots since CreateEvent before an entry is allowed
const STAKE_SOL = 1.0; // most SOL into one position in total
const FIRST_SOL = 0.05; // first buy of a position
const ADD_SOL = 0.15; // each add-on buy
const MIN_BUY_SOL = 0.01; // smallest buy worth sending
const BUY_SLIP_BPS = 1500;
const STOP_LOSS = 0.15; // exit when value < cost * (1 - STOP_LOSS)
const TRAIL = 0.25; // trailing stop from the best close value
const TRAIL_ARM = 0.10; // trailing stop arms once value >= cost * (1 + TRAIL_ARM)
const FADE_WINDOW = 20; // exit when net SOL over this window < -FADE_NET_SOL
const FADE_NET_SOL = 1.0;
const BIG_SELL_SOL = 5; // exit on any single recorded sell this big
const MAX_HOLD = 1500; // exit after this many slots held
const COOLDOWN = 200; // slots to wait after an exit before re-buying a curve
const MAX_ENTRIES = 2; // most entries per curve over the run
const MAX_MAIN = 5; // most momentum positions open at once
const MAX_EXPOSURE_SOL = 6; // most SOL at cost across all positions at once
// Guardrail pacing.
const TARGET_COINS = 25;
const TARGET_FILLS = 120;
const PACE_SECS = 21_600; // 6h final window
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

function createStrategy(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = WINDOW + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
    if (t.created === null || now - t.created < MIN_AGE) return false;
    const from = now - WINDOW;
    const mid = now - WINDOW / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
    if (buySol - sellSol < MIN_NET_SOL) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < MIN_UP || up > MAX_UP) return false;
    if (last < high * NEAR_HIGH) return false;
    // Acceleration: the newer half of the window must inflow at least as
    // much as the older half.
    if (netNew <= 0 || netNew < netOld) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
        if (!exit && flow(t, now, FADE_WINDOW) < -FADE_NET_SOL) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > MAX_HOLD) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = MAX_MAIN - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(FIRST_SOL, STAKE_SOL);
        } else {
          // Pyramid into strength only: price at or above the last buy's
          // decision price, position up, net SOL still flowing in.
          if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, WINDOW) < MIN_NET_SOL) continue;
          if (rqSol > MAX_RQ_SOL) continue;
          want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
        const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
        const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
        if (needCoins || needFills) {
          const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= MAX_PROBES) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < PROBE_SOL + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
            probes.set(mint, false);
            free -= PROBE_SOL + tx;
          }
        }
      }
      return orders;
    },
  };
}

await runBot(createStrategy());
