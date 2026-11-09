// agent-fun/replay/v2 bot shim for Node 22. Zero dependencies and erasable TypeScript only, so it
// runs as-is under the grader's fixed command `node /bot/main.ts` (Node strips the types; no build,
// no install). Copy this one file into your bot's repository (vendor/makefun-bot.ts keeps it out of
// the authorship counts) and hand runBot your strategy:
//
//   import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
//
//   await runBot({
//     onHello(state) {},                 // optional: once, before the first batch
//     onBatch(state, batch) {            // once per batch: the orders decided on this slot
//       return [{ side: 'buy', mint, quote_lamports: LAMPORTS_PER_SOL / 20n, max_slippage_bps: 500 }];
//     },
//     onDone(state, done) {},            // optional: once, last; no reply is sent
//   });
//
// The shim owns the wire. It reads one JSON line at a time from stdin (each at most
// MAX_HARNESS_LINE_BYTES), keeps `state` current (account, positions, every curve's latest reserves,
// the orders still in flight), calls onBatch and writes exactly one reply per batch (at most
// MAX_BOT_LINE_BYTES), echoing the batch's seq, before it reads the next line. Amounts may be bigint,
// u64 decimal strings or safe integers; the shim writes them as decimal strings and fills in client_id
// when you leave it out. An order the harness would treat as a protocol violation (malformed mint,
// amount, bps or client_id, a client_id starting with `_`, an unknown key, a reply line over the
// limit) throws OrderError here, so a broken bot fails on your machine and not in grading. So does a
// reply with more orders than hello.caps.max_orders_per_batch: the harness rejects the orders past
// the cap and fails the run on a reply far over it. Orders the market refuses (position and size caps,
// cash, slippage) are not errors: they come back in a later batch's fills with status "rejected" and
// a reason.
//
// Two market rules worth knowing before you size orders: the buys on one coin in one reply share one
// size cap (state.maxBuyLamports), and your own fills on one coin in one slot move the reserves for
// each other, so splitting an order never gets you a better price than sending it whole.
//
// stdout carries replies only: write diagnostics to stderr (console.error). Determinism: every entry
// is executed twice and the two action logs must match byte for byte, so never read the clock, the
// environment or Math.random; seed any randomness from state.hello.seed.

export const PROTOCOL = 'agent-fun/replay/v2';
/** Harness -> bot lines (hello, batch, done) are at most this many UTF-8 bytes, the `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines (your replies) are at most this many UTF-8 bytes, the `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Basis points per unit: 10_000 bps = 100%. */
export const BPS = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

// ---------------------------------------------------------------- wire types (contracts/protocol.ts)

/** A u64 as a canonical decimal string; read it with BigInt. */
export type U64 = string;
/** An i64 as a canonical decimal string. */
export type I64 = string;
/** A base58 Solana address. */
export type Pubkey = string;

export interface Universe {
  program: typeof PUMP_PROGRAM_ID;
  quote: 'SOL';
  /** Mayhem-mode coins (CreateEvent is_mayhem_mode) are never delivered. */
  mayhem: 'excluded';
  /** Cashback-enabled coins (CreateEvent is_cashback_enabled) are never delivered. */
  exclude_cashback: true;
  /** A mint is in iff sha256(base58 mint) as a big-endian integer mod modulus equals residue. */
  sample: { hash: 'sha256'; modulus: number; residue: number };
}

export interface Caps {
  max_open_positions: number;
  /**
   * The buys on one mint in one reply may together spend at most this share (bps) of the mint's real
   * SOL reserve at decision time; in reply order, a buy that would take the total past it is rejected
   * (reason max_order_size) and does not count toward it.
   */
  max_order_bps_of_real_reserve: number;
  /**
   * Orders beyond this many in one reply are rejected (reason max_orders_per_batch). This shim
   * refuses such a reply instead of sending it: onBatch returning more throws OrderError.
   */
  max_orders_per_batch: number;
  shorts: false;
  leverage: false;
}

export interface Fees {
  protocol_bps_fallback: number;
  creator_bps_fallback: number;
  base_fee_lamports: U64;
  priority_fee_lamports: U64;
  /** Share of orders whose transaction fails (seeded), in bps. */
  failed_tx_bps: number;
}

export interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  /** The run's seed (u64): the only source of randomness a bot may use. */
  seed: U64;
  universe: Universe;
  capital: { lamports: U64 };
  caps: Caps;
  /** Orders decided on the batch for slot s fill at slot s + latency_slots. */
  latency_slots: number;
  fees: Fees;
}

export interface Shareholder {
  address: Pubkey;
  share_bps: number;
}

/** What the collector adds to every decoded event. */
export interface ChainMeta {
  slot: number;
  signature: string;
  block_time: number | null;
  /** 0-based position of the event in its mint's event chain. */
  chain_seq: number;
}

/** A trade on a curve. Reserves are POST-trade; on SOL curves the *_quote_* fields are the ones to use. */
export interface TradeEventRecord extends ChainMeta {
  event: 'TradeEvent';
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: Pubkey;
  timestamp: I64;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  fee_recipient: Pubkey;
  fee_basis_points: U64;
  fee: U64;
  creator: Pubkey;
  creator_fee_basis_points: U64;
  creator_fee: U64;
  track_volume: boolean;
  total_unclaimed_tokens: U64;
  total_claimed_tokens: U64;
  current_sol_volume: U64;
  last_update_timestamp: I64;
  ix_name: string;
  mayhem_mode: boolean;
  cashback_fee_basis_points: U64;
  cashback: U64;
  buyback_fee_basis_points: U64;
  buyback_fee: U64;
  shareholders: Shareholder[];
  quote_mint: Pubkey;
  quote_amount: U64;
  virtual_quote_reserves: U64;
  real_quote_reserves: U64;
  holder_rewards_bps: U64;
  holder_rewards: U64;
  creator_fee_unclaimed: U64;
}

/** A new curve: its initial reserves (real SOL starts at 0). */
export interface CreateEventRecord extends ChainMeta {
  event: 'CreateEvent';
  name: string;
  symbol: string;
  uri: string;
  mint: Pubkey;
  bonding_curve: Pubkey;
  user: Pubkey;
  creator: Pubkey;
  timestamp: I64;
  virtual_token_reserves: U64;
  virtual_sol_reserves: U64;
  real_token_reserves: U64;
  token_total_supply: U64;
  token_program: Pubkey;
  is_mayhem_mode: boolean;
  is_cashback_enabled: boolean;
  quote_mint: Pubkey;
  virtual_quote_reserves: U64;
  creator_fee_bps: U64;
  is_holder_reward: boolean;
  depth: number;
}

/** The curve completed (migrated): its tradable life is over and positions in it are closed. */
export interface CompleteEventRecord extends ChainMeta {
  event: 'CompleteEvent';
  user: Pubkey;
  mint: Pubkey;
  bonding_curve: Pubkey;
  timestamp: I64;
  quote_mint: Pubkey;
}

export type ChainEvent = TradeEventRecord | CreateEventRecord | CompleteEventRecord;

/** The latest post-trade reserves of a mint the bot holds or has an order pending in. */
export interface Mark {
  mint: Pubkey;
  /** Slot of the trade these reserves follow. */
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

export interface Position {
  mint: Pubkey;
  token_amount: U64;
  /** SOL spent on the tokens still held (fees included). */
  cost_lamports: U64;
}

export interface Account {
  cash_lamports: U64;
  positions: Position[];
}

export type Side = 'buy' | 'sell';

export const REJECT_REASONS = [
  'max_slippage',
  'max_open_positions',
  'max_order_size',
  'max_orders_per_batch',
  'insufficient_cash',
  'insufficient_tokens',
  'not_in_universe',
  'token_complete',
  'zero_amount',
  'duplicate_client_id',
  'after_end',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/**
 * How an order resolved: filled, rejected (nothing paid) or failed (tx fees paid, nothing traded).
 * The harness's own closes arrive as sell fills too, with client_id `_complete_<n>` (the curve
 * completed), `_flatten_<n>` (the replay ended) or `_writeoff_<n>` (the close would not cover its tx
 * fees: tokens written off, quote_lamports "0").
 */
export interface Fill {
  /** Your order's client_id, or a harness close's (`_complete_<n>`, `_flatten_<n>`, `_writeoff_<n>`). */
  client_id: string;
  mint: Pubkey;
  side: Side;
  status: 'filled' | 'rejected' | 'failed';
  /** Set exactly when status is rejected. */
  reason: RejectReason | null;
  /** Slot of the batch the order was decided on. */
  decided_slot: number;
  /** Slot it resolved at. */
  slot: number;
  /** Buy: SOL spent, fees included. Sell: SOL received, fees deducted. "0" unless filled. */
  quote_lamports: U64;
  /** Buy: tokens received. Sell: tokens sold. "0" unless filled. */
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

export interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  /** This slot's universe events in chain order. */
  events: ChainEvent[];
  marks: Mark[];
  /** Orders that resolved since the previous batch, in resolution order. */
  fills: Fill[];
  /** The account after those fills. */
  account: Account;
}

export interface Done {
  type: 'done';
  seq: number;
  reason: 'end_of_data' | 'aborted';
  /** The final account after flattening. */
  account: Account;
}

export type HarnessMessage = Hello | Batch | Done;

export interface BuyOrder {
  side: 'buy';
  client_id: string;
  mint: Pubkey;
  /** SOL to spend, curve fees included. */
  quote_lamports: U64;
  max_slippage_bps: number;
}

export interface SellOrder {
  side: 'sell';
  client_id: string;
  mint: Pubkey;
  token_amount: U64;
  max_slippage_bps: number;
}

export type Order = BuyOrder | SellOrder;

export interface Reply {
  type: 'reply';
  seq: number;
  orders: Order[];
}

// ---------------------------------------------------------------- what onBatch returns

/** bigint, a u64 decimal string, or a non-negative safe integer. */
export type Amount = bigint | string | number;

export interface BuyInput {
  side: 'buy';
  mint: Pubkey;
  /** SOL to spend, curve fees included. */
  quote_lamports: Amount;
  /** Reject the fill when its output is worse than the decision-time reserves give by more than this. */
  max_slippage_bps: number;
  /**
   * 1-64 of [A-Za-z0-9_-], not starting with `_` (reserved for the harness's closes), unique in the
   * run; the shim assigns one (o1, o2, ...) when omitted.
   */
  client_id?: string;
}

export interface SellInput {
  side: 'sell';
  mint: Pubkey;
  /** Tokens to sell. */
  token_amount: Amount;
  max_slippage_bps: number;
  /** As on a buy: never starting with `_`, unique in the run, assigned when omitted. */
  client_id?: string;
}

export type OrderInput = BuyInput | SellInput;

// ---------------------------------------------------------------- errors

/** The harness sent something this shim cannot follow (wrong protocol, malformed line, bad order of messages). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The bot returned something the harness would treat as a protocol violation. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

// ---------------------------------------------------------------- state

/** A bonding curve the bot has seen, at its latest known reserves. */
export interface Curve {
  readonly mint: Pubkey;
  /** Slot of its CreateEvent; null when the shim saw the mint first through a trade or a mark. */
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  /** Slot of the trade the reserves follow (the create slot until the first trade). */
  reserves_slot: number;
  /** TradeEvents seen on it. */
  trades: number;
  /** Its CompleteEvent arrived: no more orders (they would be rejected token_complete). */
  complete: boolean;
}

/** A held position, as the latest account reports it. */
export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

/** An order sent and not yet reported back in a fill. */
export interface PendingOrder {
  readonly order: Order;
  /** Seq and slot of the batch it was decided on. */
  readonly seq: number;
  readonly decided_slot: number;
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** 1-64 of [A-Za-z0-9_-], not starting with `_`: ids starting with `_` are the harness's closes. */
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/**
 * Everything the bot knows, kept current by runBot before each callback. You can also drive it
 * yourself to unit-test a strategy: `const s = new BotState(hello); s.applyBatch(batch); onBatch(s, batch)`.
 */
export class BotState {
  readonly hello: Hello;
  /** Seq of the batch being answered (-1 before the first batch). */
  seq = -1;
  /** Slot of the batch being answered (-1 before the first batch). */
  slot = -1;
  /** The account as of the latest batch (or done). */
  account: Account;
  /** account.cash_lamports as a bigint. Orders still pending are not deducted: see freeCashLamports. */
  cash: bigint;
  /** Positions with tokens, by mint. */
  readonly positions = new Map<Pubkey, Holding>();
  /** Every curve seen, by mint, in first-seen order. */
  readonly curves = new Map<Pubkey, Curve>();
  /** Orders sent and not yet reported in a fill, by client_id, in send order. */
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = BigInt(hello.capital.lamports);
  }

  /** A fresh client_id (o1, o2, ...), never one already used in this run and never starting with `_`. */
  clientId(): string {
    const id = this.#freeId(null);
    this.#used.add(id);
    return id;
  }

  /** Base + priority fee every sent order pays, filled or not. */
  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /**
   * The size cap on this mint now: the most this batch's buys on it may spend together (the sum of
   * their quote_lamports); 0n when unknown or complete.
   */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy pending: what counts against caps.max_open_positions. */
  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  /** Cash minus what pending orders will take if they fill (buy amounts and every tx fee). May go negative. */
  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  /** Fold a batch in: its fills, account, marks and events (in that order). runBot calls this. */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  /** Fold the final account in. runBot calls this before onDone. */
  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /**
   * Validate what onBatch returned and turn it into wire orders (assigning missing client_ids).
   * Throws OrderError on anything the harness would call a protocol violation, and on more orders
   * than hello.caps.max_orders_per_batch. Does not record them.
   */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new OrderError(`batch ${this.seq}: onBatch must return an array of orders, got ${describe(result)}`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new OrderError(
        `batch ${this.seq}: onBatch returned ${result.length} orders, over hello.caps.max_orders_per_batch (${cap}); ` +
          `the harness rejects the orders past the cap and fails the run on a reply far over it, so send at most ${cap} per batch`,
      );
    }
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.seq} order ${i}`));
    const taken = new Set<string>();
    for (const o of checked) if (o.client_id !== undefined) taken.add(o.client_id);
    return checked.map((o) => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
    });
  }

  /** Record orders as sent on the current batch: they stay in `pending` until their fill arrives. */
  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  #freeId(taken: Set<string> | null): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id) && (taken === null || !taken.has(id))) return id;
    }
  }

  #newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
    }
  }
}

interface CheckedOrder {
  side: Side;
  client_id: string | undefined;
  mint: Pubkey;
  amount: U64;
  max_slippage_bps: number;
}

const BUY_KEYS = new Set(['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps']);
const SELL_KEYS = new Set(['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps']);

function checkOrder(value: unknown, where: string): CheckedOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OrderError(`${where}: expected an order object, got ${describe(value)}`);
  const o = value as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') throw new OrderError(`${where}: side must be "buy" or "sell", got ${describe(o.side)}`);
  const allowed = o.side === 'buy' ? BUY_KEYS : SELL_KEYS;
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) throw new OrderError(`${where}: unknown key "${k}" on a ${o.side} order`);
  }
  if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) throw new OrderError(`${where}: mint must be a base58 address, got ${describe(o.mint)}`);
  const amountKey = o.side === 'buy' ? 'quote_lamports' : 'token_amount';
  const amount = toU64(o[amountKey], `${where}: ${amountKey}`);
  const bps = o.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new OrderError(`${where}: max_slippage_bps must be an integer 0..10000, got ${describe(bps)}`);
  }
  let client_id: string | undefined;
  if (o.client_id !== undefined) {
    if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
      throw new OrderError(`${where}: client_id must be 1-64 of [A-Za-z0-9_-] not starting with _ (reserved for the harness's closes), got ${describe(o.client_id)}`);
    }
    client_id = o.client_id;
  }
  return { side: o.side, client_id, mint: o.mint, amount, max_slippage_bps: bps };
}

/** An amount as a canonical u64 decimal string; throws OrderError when it is not one. */
export function toU64(value: unknown, what = 'amount'): U64 {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) {
    throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
  }
  return n.toString();
}

function describe(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

// ---------------------------------------------------------------- the line loop

/**
 * Split a byte stream into lines (`\n`-terminated, a trailing `\r` dropped), each decoded as strict
 * UTF-8. A line longer than maxBytes throws ProtocolError; an unterminated last line is yielded.
 */
export async function* readLines(input: AsyncIterable<Uint8Array | string>, maxBytes = MAX_HARNESS_LINE_BYTES): AsyncGenerator<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let size = 0;
  let lineNo = 0;
  const take = (last: Uint8Array): string => {
    let bytes: Uint8Array = last;
    if (parts.length > 0) {
      bytes = new Uint8Array(size);
      let at = 0;
      for (const p of [...parts, last]) {
        bytes.set(p, at);
        at += p.byteLength;
      }
    }
    parts = [];
    size = 0;
    lineNo++;
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) bytes = bytes.subarray(0, bytes.byteLength - 1);
    try {
      return decoder.decode(bytes);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not valid UTF-8`);
    }
  };
  const tooLong = (n: number) => new ProtocolError(`input line ${lineNo + 1} is over ${maxBytes} bytes (${n} so far)`);
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    let start = 0;
    for (;;) {
      const nl = bytes.indexOf(0x0a, start);
      if (nl === -1) break;
      const piece = bytes.subarray(start, nl);
      if (size + piece.byteLength > maxBytes) throw tooLong(size + piece.byteLength);
      size += piece.byteLength;
      yield take(piece);
      start = nl + 1;
    }
    if (start < bytes.byteLength) {
      const rest = new Uint8Array(bytes.subarray(start));
      size += rest.byteLength;
      if (size > maxBytes) throw tooLong(size);
      parts.push(rest);
    }
  }
  if (size > 0) yield take(new Uint8Array(0));
}

/** Where replies go: process.stdout by default. A false from write() waits for 'drain' when once() exists. */
export interface LineWriter {
  write(chunk: string): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}

export interface BotIO {
  /** Harness lines; process.stdin by default. */
  input?: AsyncIterable<Uint8Array | string>;
  /** Replies; process.stdout by default. */
  output?: LineWriter;
}

export type OrdersResult = readonly OrderInput[] | void | null | undefined;

export interface Bot {
  /** Once, after hello and before the first batch. */
  onHello?(state: BotState): void | Promise<void>;
  /** Once per batch, after state took the batch in: the orders to send. Nothing returned = no orders. */
  onBatch(state: BotState, batch: Batch): OrdersResult | Promise<OrdersResult>;
  /** Once, after the final account (positions already flattened) took effect. No reply is sent. */
  onDone?(state: BotState, done: Done): void | Promise<void>;
}

export interface RunResult {
  state: BotState;
  done: Done;
  /** Batches answered. */
  batches: number;
}

/**
 * Speak agent-fun/replay/v2 on stdin/stdout until done, then stop reading and resolve (the process
 * exits once stdout drains, even when the harness keeps stdin open). Rejects with ProtocolError,
 * OrderError or whatever a callback threw; unhandled, that ends the process with exit code 1.
 */
export async function runBot(bot: Bot, io: BotIO = {}): Promise<RunResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const encoder = new TextEncoder();
  let state: BotState | null = null;
  let batches = 0;
  let lineNo = 0;
  for await (const line of readLines(input)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    const type = typeof msg === 'object' && msg !== null && !Array.isArray(msg) ? (msg as { type?: unknown }).type : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== PROTOCOL) throw new ProtocolError(`the harness speaks ${describe(hello.protocol)}; this shim speaks ${PROTOCOL}`);
      state = new BotState(hello);
      await bot.onHello?.(state);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      checkBatch(batch, lineNo);
      state.applyBatch(batch);
      const orders = state.toOrders(await bot.onBatch(state, batch));
      const reply: Reply = { type: 'reply', seq: batch.seq, orders };
      const text = JSON.stringify(reply);
      const bytes = encoder.encode(text).byteLength;
      if (bytes > MAX_BOT_LINE_BYTES) {
        throw new OrderError(`batch ${batch.seq}: the reply is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES}); send fewer orders (caps.max_orders_per_batch is ${state.hello.caps.max_orders_per_batch})`);
      }
      state.recordOrders(orders);
      await writeLine(output, `${text}\n`);
      batches++;
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      await bot.onDone?.(state, done);
      return { state, done, batches };
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${describe(type)}`);
    }
  }
  throw new ProtocolError(state === null ? 'input ended before hello' : `input ended before done (after ${batches} batches)`);
}

function checkBatch(batch: Batch, lineNo: number): void {
  const ok =
    Number.isSafeInteger(batch.seq) &&
    Number.isSafeInteger(batch.slot) &&
    Array.isArray(batch.events) &&
    Array.isArray(batch.marks) &&
    Array.isArray(batch.fills) &&
    typeof batch.account === 'object' &&
    batch.account !== null &&
    Array.isArray(batch.account.positions);
  if (!ok) throw new ProtocolError(`input line ${lineNo}: malformed batch`);
}

function writeLine(output: LineWriter, text: string): Promise<void> | void {
  const ok = output.write(text);
  if (ok === false && typeof output.once === 'function') {
    const once = output.once.bind(output);
    return new Promise<void>((resolve) => {
      once('drain', resolve);
    });
  }
}
