# Strategy

A replay bot for pump.fun SOL bonding curves. It is a pure function of the batch stream: no clock,
no randomness, no environment, no network. All amounts are `bigint` lamports.

## What it trades

Every SOL-quoted `CreateEvent` starts a coin record: creator, create slot, and initial virtual
reserves. Non-SOL quotes are ignored. Each `TradeEvent` refreshes the virtual reserves, increments
the trade count, records non-creator buyers, accumulates bought/sold lamports, flags a creator sell,
and appends `(slot, is_buy, sol, user)` ticks trimmed to the last 20 slots. A `CompleteEvent` marks
the coin complete and done.

A coin is entered only when the tape looks alive and non-toxic:

- real SOL in the curve (`vq - 30 SOL`) is at least **20 SOL**;
- at least **4 trades** and **3 distinct non-creator buyers**;
- bought lamports are at least **1.2x** sold lamports (no sells passes);
- the creator has not sold;
- the coin is at most **400 slots** old;
- it is not held, already entered, or done.

At most one new coin is entered per batch, only while fewer than 5 positions are committed (held or
with a buy in flight), and never while a buy on that mint is pending.

## Sizing

Entry spends `min(realSol / 100, 0.12 SOL)`, skipping anything under `0.02 SOL`, with
`max_slippage_bps = 2000`.

A held coin may be scaled into once per batch (no pending buy or sell) when its position cost is
below `1.8 SOL`, it has had fewer than 8 adds, the real reserve is at least **30 SOL**, and the
current price `vq/vt` is at least **1.25x** the price at the previous buy decision. Prices are
compared by cross-multiplying `vq * lastVt` against `lastVq * vt`, so no floating point is involved.
An add spends `min(realSol / 100, 0.25 SOL)`, skipping under `0.015 SOL`, with
`max_slippage_bps = 2000`. The decision price is recorded on entry and on every add.

Exits, adds, and entries are evaluated in that priority order, capped at **16 orders per batch**.

## Exits

Positions are tracked from `batch.fills`: opened slot, transaction fees paid, best sell value seen,
and add count. Harness closes (client ids starting with `_`) and positions absent from the account
clear that state.

For a whole-position sell, `value = q - ceil(q * 125 / 10000)` with `q = tokens * vq / (vt + tokens)`,
and `basis = cost_lamports + tx fees paid`. It exits when any holds:

- **Stop loss:** `value <= 70%` of basis.
- **Trailing take-profit:** the best value seen reached `125%` of basis and value has fallen to
  `55%` of that best.
- **Stale hold:** held at least `1200` slots and value is below `115%` of basis.

Exits always sell the whole position with `max_slippage_bps = 10000`, and no second sell is sent
while one is pending. A completed or exited coin is marked done and never re-entered.
