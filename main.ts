// Graduation-sprint bot for agent-fun/replay/v2. Runs as `node /bot/main.ts` (Node 22 type
// stripping; erasable TypeScript only). A pure function of the batches it is fed: no clock, no
// randomness, no environment and no I/O beyond what runBot owns. Amounts are bigint lamports.
//
// The idea: a pump.fun bonding curve completes near 85 SOL of real reserves and the replay closes
// a position still open then at the curve's last price. Young curves that reach the 45-70 SOL band
// fast, on broad buying, finish that run far more often than the average coin dies. So the bot
// enters that band with velocity and holder-breadth filters, builds a position in tranches inside
// the per-reply cap, takes half at 72 SOL and the rest at 76 (or lets completion close it), stops
// out 25% below its entry price and gives up after 1500 slots. Tiny probes on calm older coins keep
// the competition's 20-coin round-trip guardrail satisfied.

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
const FEE_BPS = 125n;
const BPS = 10_000n;
const MAX_ORDERS = 16;

/** Entry band on the curve's recorded real SOL reserve. */
const BAND_LO = 45n * SOL;
const BAND_HI = 70n * SOL;
/** Only young curves sprint: skip the bundled launch slots and the long tail. */
const MIN_AGE = 30;
const MAX_AGE = 900;
/** At least 15 SOL bought in the last 30 slots. */
const VEL_WINDOW = 30;
const VEL_MIN = 15n * SOL;
/** The five largest buyers must not hold more than 30% of all buy volume. */
const TOP5_MAX_BPS = 3_000n;
/** Target position (lamports, curve fees included) and the smallest order worth sending. */
const TARGET = 4_000_000_000n;
const MIN_BUY = 20_000_000n;
/** Tranches are added only within 8% of the entry price and 60 slots of the entry. */
const ADD_BAND_BPS = 10_800n;
const ADD_WINDOW = 60;
/** Exits: half at 72 SOL, the rest at 76, a 25% stop and a 1500-slot time limit. */
const TP1_RQ = 72n * SOL;
const TP2_RQ = 76n * SOL;
const STOP_BPS = 7_500n;
const MAX_HOLD = 1500;
/** At most 3 graduation positions at once, inside the replay's limit of 5. */
const MAX_GRAD = 3;
/** Keep a total loss of everything at risk inside 45% of the equity peak. */
const DD_CAP_BPS = 4_500n;

/** Probe round trips: tiny buys on older coins, held briefly, one at a time. */
const PROBE_TARGET = 50;
const PROBE_SIZE = 12_500_000n;
const PROBE_HOLD = 30;
const PROBE_GAP = 150;
const PROBE_MIN_AGE = 120;
const PROBE_MIN_RQ = 1n * SOL;
const PROBE_SLIPPAGE = 3_000;
const BUY_SLIPPAGE = 2_000;
const SELL_SLIPPAGE = 9_000;
/** 0 idle, 1 graduation position, 2 probe, 3 done for good. */
type Phase = 0 | 1 | 2 | 3;

interface Tick {
  slot: number;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  vq: bigint;
  vt: bigint;
  complete: boolean;
  phase: Phase;
  /** Decision reserves and slot of the entry, compared by cross-multiplication. */
  entryVq: bigint;
  entryVt: bigint;
  entrySlot: number;
  /** Take-profit state: the first half has been sent / has filled. */
  tp1Pending: boolean;
  tp1Done: boolean;
  /** A stop, take-profit or time sell is in flight. */
  exiting: boolean;
  /** Halvings of the next sell after max_order_size rejections (a drained curve). */
  sellShift: number;
  /** Buy volume per wallet, kept only while the coin can still enter (age <= MAX_AGE). */
  buyVol: Map<Pubkey, bigint> | null;
  /** Recent buy ticks (slot, lamports), for the velocity filter. */
  recent: Tick[];
  recentHead: number;
}

const coins = new Map<Pubkey, Coin>();

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  return q - fee;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function sellPart(tokens: bigint, shift: number): bigint {
  const part = tokens >> BigInt(shift);
  return part > 0n ? part : tokens;
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function velocity(c: Coin, slot: number): bigint {
  const lo = slot - VEL_WINDOW;
  while (c.recentHead < c.recent.length && c.recent[c.recentHead]!.slot < lo) c.recentHead++;
  if (c.recentHead > 512 && c.recentHead * 2 > c.recent.length) {
    c.recent = c.recent.slice(c.recentHead);
    c.recentHead = 0;
  }
  let sum = 0n;
  for (let i = c.recentHead; i < c.recent.length; i++) sum += c.recent[i]!.sol;
  return sum;
}

function top5ShareBps(c: Coin): bigint {
  if (c.buyVol === null || c.buyVol.size === 0) return BPS;
  const vols = [...c.buyVol.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  let total = 0n;
  for (const v of vols) total += v;
  if (total === 0n) return BPS;
  let top = 0n;
  for (let i = 0; i < vols.length && i < 5; i++) top += vols[i]!;
  return (top * BPS) / total;
}

let probesUsed = 0;
let nextProbe = 0;
let peakEquity = -1n;
const touched: Pubkey[] = [];
const touchedSet = new Set<Pubkey>();

function readEvents(state: BotState, batch: Batch): void {
  touched.length = 0;
  touchedSet.clear();
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (e.quote_mint !== SOL_MINT) continue;
      if (coins.has(e.mint)) continue;
      coins.set(e.mint, {
        mint: e.mint,
        creator: e.creator,
        createSlot: e.slot,
        vq: BigInt(e.virtual_quote_reserves),
        vt: BigInt(e.virtual_token_reserves),
        complete: false,
        phase: 0,
        entryVq: 0n,
        entryVt: 1n,
        entrySlot: -1,
        tp1Pending: false,
        tp1Done: false,
        exiting: false,
        sellShift: 0,
        buyVol: new Map(),
        recent: [],
        recentHead: 0,
      });
      if (!touchedSet.has(e.mint)) {
        touchedSet.add(e.mint);
        touched.push(e.mint);
      }
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      c.vq = BigInt(e.virtual_quote_reserves);
      c.vt = BigInt(e.virtual_token_reserves);
      if (e.is_buy) {
        const sol = BigInt(e.sol_amount);
        c.buyVol?.set(e.user, (c.buyVol.get(e.user) ?? 0n) + sol);
        c.recent.push({ slot: e.slot, sol });
      }
      if (!touchedSet.has(e.mint)) {
        touchedSet.add(e.mint);
        touched.push(e.mint);
      }
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        if (!state.positions.has(c.mint)) c.phase = 3;
      }
    }
  }
}

function readFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    const c = coins.get(f.mint);
    if (c === undefined) continue;
    if (f.client_id.startsWith('_')) {
      // Harness close: the position is gone and the coin is done.
      c.phase = 3;
      c.exiting = false;
      c.tp1Pending = false;
      continue;
    }
    if (f.side === 'sell') {
      c.exiting = false;
      if (c.tp1Pending) {
        if (f.status === 'filled') c.tp1Done = true;
        c.tp1Pending = false;
      }
      if (f.status === 'rejected' && f.reason === 'max_order_size' && c.sellShift < 8) c.sellShift++;
      if (f.status === 'filled' && !state.positions.has(f.mint)) {
        c.phase = c.tp1Done ? 3 : 0;
        c.entryVq = 0n;
        c.entryVt = 1n;
        c.entrySlot = -1;
      }
    } else if (f.status !== 'filled' && !state.positions.has(f.mint) && !hasPending(state, f.mint, 'buy')) {
      // An opening buy that never filled: the coin is free again while its setup still holds.
      if (c.phase === 2) probesUsed--;
      c.phase = 0;
      c.entryVq = 0n;
      c.entryVt = 1n;
      c.entrySlot = -1;
    }
  }
}

function step(state: BotState, batch: Batch): OrderInput[] {
  readEvents(state, batch);
  readFills(state, batch);

  for (const mint of touched) {
    const c = coins.get(mint)!;
    if (c.phase === 0 && batch.slot - c.createSlot > MAX_AGE) {
      c.buyVol = null;
      c.recent = [];
      c.recentHead = 0;
    }
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

  const buyCap = (r: { vq: bigint }): bigint => {
    const real = r.vq - VIRTUAL_OFFSET;
    if (real <= 0n) return 0n;
    return ((real * BigInt(state.hello.caps.max_order_bps_of_real_reserve)) / BPS) * 97n / 100n;
  };

  // Equity as the harness marks it, its peak, and what could be lost if every open sprint position
  // emptied at once. New buys are limited so that losses stay inside the drawdown guardrail.
  let eq = state.cash;
  let atRisk = 0n;
  for (const [mint, holding] of state.positions) {
    const r = reserves(mint);
    if (r === null) continue;
    const value = sellValue(holding.token_amount, r.vq, r.vt);
    eq += value;
    if (coins.get(mint)?.phase === 1) atRisk += value;
  }
  for (const p of state.pending.values()) {
    if (p.order.side !== 'buy') continue;
    const c = coins.get(p.order.mint);
    if (c !== undefined && c.phase === 1) atRisk += BigInt(p.order.quote_lamports);
  }
  if (eq > peakEquity) peakEquity = eq;
  let headroom = eq - (peakEquity * (BPS - DD_CAP_BPS)) / BPS - atRisk;
  if (headroom < 0n) headroom = 0n;

  // 1. Exits and tranche adds on held graduation positions, in mint order.
  for (const mint of [...state.positions.keys()].sort()) {
    if (orders.length >= cap) break;
    const holding = state.positions.get(mint)!;
    const c = coins.get(mint);
    if (c === undefined) continue;
    if (hasPending(state, mint, 'sell')) continue;
    const r = reserves(mint);
    if (r === null) continue;
    if (c.phase === 2) {
      if (batch.slot - c.entrySlot >= PROBE_HOLD) {
        orders.push({ side: 'sell', mint, token_amount: sellPart(holding.token_amount, c.sellShift), max_slippage_bps: SELL_SLIPPAGE });
        c.exiting = true;
      }
      continue;
    }
    if (c.phase !== 1 || c.complete) continue;
    const real = r.vq - VIRTUAL_OFFSET;
    const stop = r.vq * c.entryVt * BPS <= c.entryVq * r.vt * STOP_BPS;
    const stale = batch.slot - c.entrySlot > MAX_HOLD;
    if (stop || real >= TP2_RQ || stale) {
      orders.push({ side: 'sell', mint, token_amount: sellPart(holding.token_amount, c.sellShift), max_slippage_bps: SELL_SLIPPAGE });
      c.exiting = true;
      continue;
    }
    if (!c.tp1Done && !c.tp1Pending && real >= TP1_RQ) {
      const part = holding.token_amount / 2n;
      if (part > 0n) {
        orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: SELL_SLIPPAGE });
        c.tp1Pending = true;
        c.exiting = true;
      }
      continue;
    }
    if (c.exiting || holding.cost_lamports >= TARGET) continue;
    if (batch.slot - c.entrySlot > ADD_WINDOW) continue;
    if (r.vq * c.entryVt * BPS > c.entryVq * r.vt * ADD_BAND_BPS) continue;
    let amount = TARGET - holding.cost_lamports;
    amount = min(amount, buyCap(r));
    amount = min(amount, headroom);
    if (amount < MIN_BUY) continue;
    if (state.freeCashLamports() - amount <= 0n) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE });
    headroom -= amount;
  }

  // 2. New graduation entries on coins that traded this slot. One per batch keeps the books calm.
  let gradOpen = 0;
  for (const [mint] of state.positions) if (coins.get(mint)?.phase === 1) gradOpen++;
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && coins.get(p.order.mint)?.phase === 1 && !state.positions.has(p.order.mint)) gradOpen++;
  }
  if (gradOpen < MAX_GRAD && state.committedPositionCount() < 5 && headroom > 0n) {
    for (const mint of touched) {
      if (orders.length >= cap) break;
      const c = coins.get(mint)!;
      if (c.phase !== 0 || c.complete) continue;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      const age = batch.slot - c.createSlot;
      if (age < MIN_AGE || age > MAX_AGE) continue;
      const r = reserves(mint);
      if (r === null) continue;
      const real = r.vq - VIRTUAL_OFFSET;
      if (real < BAND_LO || real > BAND_HI) continue;
      if (velocity(c, batch.slot) < VEL_MIN) continue;
      if (top5ShareBps(c) > TOP5_MAX_BPS) continue;
      let amount = TARGET;
      amount = min(amount, buyCap(r));
      amount = min(amount, headroom);
      if (amount < 50_000_000n) continue;
      if (state.freeCashLamports() - amount <= 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE });
      c.phase = 1;
      c.entryVq = r.vq;
      c.entryVt = r.vt;
      c.entrySlot = batch.slot;
      c.tp1Done = false;
      c.tp1Pending = false;
      c.exiting = false;
      c.sellShift = 0;
      headroom -= amount;
      gradOpen += 1;
      break;
    }
  }

  // 3. Tiny probe round trips: one at a time, out of the way of the sprint books.
  let probing = false;
  for (const [mint] of state.positions) if (coins.get(mint)?.phase === 2) probing = true;
  for (const p of state.pending.values()) if (p.order.side === 'buy' && coins.get(p.order.mint)?.phase === 2) probing = true;
  if (
    !probing &&
    probesUsed < PROBE_TARGET &&
    batch.slot >= nextProbe &&
    state.committedPositionCount() < 5 &&
    gradOpen <= 2
  ) {
    for (const mint of touched) {
      const c = coins.get(mint)!;
      if (c.phase !== 0 || c.complete) continue;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      if (batch.slot - c.createSlot < PROBE_MIN_AGE) continue;
      const r = reserves(mint);
      if (r === null) continue;
      if (r.vq - VIRTUAL_OFFSET < PROBE_MIN_RQ) continue;
      if (PROBE_SIZE > buyCap(r)) continue;
      if (state.freeCashLamports() - PROBE_SIZE <= 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: PROBE_SIZE, max_slippage_bps: PROBE_SLIPPAGE });
      c.phase = 2;
      c.entryVq = r.vq;
      c.entryVt = r.vt;
      c.entrySlot = batch.slot;
      c.sellShift = 0;
      probesUsed += 1;
      nextProbe = batch.slot + PROBE_GAP;
      break;
    }
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return step(state, batch);
  },
});
