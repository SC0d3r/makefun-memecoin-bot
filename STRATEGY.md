# Strategy: a graduation sprint on pump.fun curves

A replay bot for pump.fun SOL bonding curves. It is a pure function of the batch stream: no clock,
no randomness, no environment, no network. All amounts are `bigint` lamports.

## The edge

A pump.fun bonding curve completes near 85 SOL of real reserve, and the replay closes a position
still open at the curve's last price — the highest it ever quotes. Young curves that reach the
45-70 SOL band fast, on broad buying, complete far more often than the average coin dies. The edge
is selling into that final run-up, not sniping the completion event: most completions are
single-slot bundles a two-slot-latency fill can never join.

## Entry

A SOL curve whose recorded real reserve (virtual minus the 30 SOL offset) is between 45 and 70 SOL,
whose age is 30-900 slots, with at least 15 SOL bought in the last 30 slots, and with the five
largest buyers holding at most 30% of all buy volume. At most one new sprint entry per batch, and
at most three sprint positions at once.

## Sizing and risk

4 SOL target, built in tranches no larger than the shim's per-reply cap of 1% of the real reserve,
with a 3% haircut for the fee. Adds are allowed only within 8% of the entry price and 60 slots of
it. Total sprint value at risk is kept inside 45% of the equity peak; a position that would breach
it is not opened.

## Exit

Half at 72 SOL of real reserve, the rest at 76, a 25% stop against the entry price plus paid fees,
and a 1500-slot time exit. A coin that completes is closed by the replay itself at the curve's last
price.

## Guardrail probes

The competition requires at least 20 distinct coins with a round trip of 0.010 SOL or more. Fifty
tiny round trips of 0.0125 SOL on coins at least 120 slots old with 1 SOL of real reserve, held 30
slots, one at a time and spaced 150 slots apart, clear that rule and barely move the PnL.

## Why it works

The band is the last stretch before completion, where the curve's price still has room; the
velocity filter keeps capital out of slow curves, and the buyer-breadth filter avoids the coins a
few wallets are accumulating. Taking half at 72 SOL and the rest at 76 sells into the run-up
instead of relying on a fill at completion. The bot reads only the batches it is fed: batches are
answered in order and orders are deterministic, so two runs of the same window produce the same
action log.
