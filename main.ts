// pump.fun replay trading bot for agent-fun/replay/v2. Runs as `node /bot/main.ts` (Node 22 type
// stripping; erasable TypeScript only). A pure function of the batches it is fed: no clock, no
// randomness, no environment, no I/O beyond what runBot owns. Every amount is a bigint in lamports.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const SOL_MINT = '11111111111111111111111111111111';
/** pump.fun's SOL curves start with 30 SOL of virtual reserve above the real one. */
const VIRTUAL_OFFSET = 30n * SOL;
/** Curve fee (protocol + creator), in bps: sellValue takes it off the gross quote. */
const FEE_BPS = 125n;
const BPS = 10_000n;
/** The reply cap this strategy enforces on itself. */
const MAX_ORDERS = 16;
/** Recent-trade ticks kept per coin, in slots. */
const RECENT_WINDOW = 20;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  /** Latest virtual reserves seen on this curve. */
  vq: bigint;
  vt: bigint;
  trades: number;
  /** Distinct wallets that bought and are not the creator. */
  buyers: Set<Pubkey>;
  bought: bigint;
  sold: bigint;
  devSold: boolean;
  recent: Tick[];
  /** A first buy has been decided for this coin: never enter it again. */
  entered: boolean;
  /** Filtered out, exited, or completed: ignore for good. */
  done: boolean;
  complete: boolean;
  /** Decision price (vq, vt) of the last buy sent (entry or add), compared by cross-multiplication. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
}

interface PosState {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  adds: number;
}

/** What selling `tokens` against (vq, vt) pays after curve fees: q - ceil(q*FEE_BPS/BPS). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  // ceil(q * FEE_BPS / BPS): the curve rounds its fee up, so must we.
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  return q - fee;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function trimRecent(coin: Coin, slot: number): void {
  const from = slot - RECENT_WINDOW;
  let drop = 0;
  while (drop < coin.recent.length && coin.recent[drop]!.slot <= from) drop++;
  if (drop > 0) coin.recent.splice(0, drop);
}

const coins = new Map<Pubkey, Coin>();
const pos = new Map<Pubkey, PosState>();

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (e.quote_mint !== SOL_MINT) continue;
      coins.set(e.mint, {
        mint: e.mint,
        creator: e.creator,
        createSlot: e.slot,
        vq: BigInt(e.virtual_quote_reserves),
        vt: BigInt(e.virtual_token_reserves),
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        sold: 0n,
        devSold: false,
        recent: [],
        entered: false,
        done: false,
        complete: false,
        lastBuyVq: 0n,
        lastBuyVt: 1n,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      c.trades += 1;
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        c.bought += sol;
        if (e.user !== c.creator) c.buyers.add(e.user);
      } else {
        c.sold += sol;
        if (e.user === c.creator) c.devSold = true;
      }
      c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
  for (const c of coins.values()) trimRecent(c, batch.slot);
}

function readFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    // Harness closes (_complete_, _flatten_, _writeoff_): the position is gone.
    if (f.client_id.startsWith('_')) {
      pos.delete(f.mint);
      continue;
    }
    let p = pos.get(f.mint);
    if (f.side === 'buy' && f.status === 'filled' && p === undefined) {
      p = { openedSlot: f.slot, txPaid: 0n, best: 0n, adds: 0 };
      pos.set(f.mint, p);
    }
    if (p !== undefined && f.status !== 'rejected') p.txPaid += BigInt(f.tx_fee_lamports);
  }
}

function step(state: BotState, batch: Batch): OrderInput[] {
  readEvents(batch);
  readFills(state, batch);

  // Forget per-position state once the position is really gone.
  for (const mint of [...pos.keys()]) {
    if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) pos.delete(mint);
  }

  const cap = Math.min(MAX_ORDERS, state.hello.caps.max_orders_per_batch);
  const orders: OrderInput[] = [];
  const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
  for (const m of batch.marks) {
    marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
  }

  const reserves = (mint: Pubkey): { vq: bigint; vt: bigint } | null => {
    const mk = marks.get(mint);
    if (mk !== undefined) return mk;
    const c = coins.get(mint);
    if (c !== undefined) return { vq: c.vq, vt: c.vt };
    const cv = state.curves.get(mint);
    if (cv !== undefined) return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    return null;
  };

  // --- EXITS (highest priority) ---
  const selling = new Set<Pubkey>();
  for (const [mint, holding] of state.positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint) || hasPending(state, mint, 'sell')) continue;
    const r = reserves(mint);
    if (r === null) continue;
    let p = pos.get(mint);
    if (p === undefined) {
      p = { openedSlot: state.slot, txPaid: 0n, best: 0n, adds: 0 };
      pos.set(mint, p);
    }
    const value = sellValue(holding.token_amount, r.vq, r.vt);
    const basis = holding.cost_lamports + p.txPaid;
    if (value > p.best) p.best = value;
    let exit = false;
    if (basis > 0n) {
      if (value * BPS <= basis * 7_000n) exit = true;
      else if (p.best * 1_000n >= basis * 1_250n && value * 100n <= p.best * 55n) exit = true;
    }
    if (state.slot - p.openedSlot >= 1_200 && value * 100n < basis * 115n) exit = true;
    if (!exit) continue;
    orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
    selling.add(mint);
    const c = coins.get(mint);
    if (c !== undefined) c.done = true;
  }

  // --- SCALE-IN (one add per held coin per batch) ---
  for (const [mint, holding] of state.positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint)) continue;
    if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
    const c = coins.get(mint);
    if (c === undefined || c.complete) continue;
    const p = pos.get(mint);
    if (p === undefined || p.adds >= 8) continue;
    if (holding.cost_lamports >= 1_800_000_000n) continue;
    const r = reserves(mint);
    if (r === null) continue;
    const realSol = r.vq - VIRTUAL_OFFSET;
    if (realSol < 30n * SOL) continue;
    // price now >= 1.25 * price at the last buy: vq/vt >= 1.25 * lastVq/lastVt (cross-multiplied).
    if (!(r.vq * c.lastBuyVt * 4n >= c.lastBuyVq * r.vt * 5n)) continue;
    const amount = min(realSol / 100n, 250_000_000n);
    if (amount < 15_000_000n) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 2_000 });
    p.adds += 1;
    c.lastBuyVq = r.vq;
    c.lastBuyVt = r.vt;
  }

  // --- ENTRIES (at most one new coin per batch) ---
  if (state.committedPositionCount() < 5) {
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.entered || c.done || c.complete) continue;
      const cv = state.curves.get(c.mint);
      if (cv !== undefined && cv.complete) {
        c.complete = true;
        c.done = true;
        continue;
      }
      if (state.positions.has(c.mint)) continue;
      if (hasPending(state, c.mint, 'buy')) continue;
      const r = reserves(c.mint);
      if (r === null) continue;
      const realSol = r.vq - VIRTUAL_OFFSET;
      if (realSol < 20n * SOL) continue;
      if (c.trades < 4) continue;
      if (c.buyers.size < 3) continue;
      if (c.sold > 0n && c.bought * 5n < c.sold * 6n) continue;
      if (c.devSold) continue;
      if (state.slot - c.createSlot > 400) {
        c.done = true;
        continue;
      }
      const amount = min(realSol / 100n, 120_000_000n);
      if (amount < 20_000_000n) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 2_000 });
      c.entered = true;
      c.lastBuyVq = r.vq;
      c.lastBuyVt = r.vt;
      break; // one new coin per batch
    }
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return step(state, batch);
  },
});
