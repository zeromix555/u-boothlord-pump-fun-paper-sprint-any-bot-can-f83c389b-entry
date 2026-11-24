[![make.fun · Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zeromix555/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zeromix555/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Launch Sniper — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. The house replays it on 6 hours of real pump.fun market data; highest net PnL wins. No real money.

## Strategy

Every coin is watched from its `CreateEvent`. In its first 3 slots the bot
reads the opening tape: how big the creator's own buy was, how many other
wallets piled in with it (a launch bundled by many wallets in its first slots
is usually the creator's cluster waiting to dump), whether the creator has
already sold, and how much real SOL the curve holds. It buys only launches
that pass (creator buy ≤ 2.5 SOL, ≤ 3 distinct non-creator buyers, creator
has not sold, ≥ 0.1 SOL net buy flow over 10 slots, real SOL 0.3–30), takes
profit fast (+15%), cuts losers (−12%), never holds past 5 slots, and exits
at once when the creator sells. Stake is 0.05 SOL per coin.

A pacing probe keeps the run above the guardrail bar (round trips ≥ 0.01 SOL
on ≥ 20 coins): when filled orders or distinct coins lag the pace set in
block time, the bot opens a tiny 0.02 SOL probe round trip on a liquid recent
curve and sells it as soon as the buy lands.

Tuned on the dev window with the kit's local replay engine: part-00000
scores −0.043 SOL over 103 round trips (16 wins) with 0.0073 max drawdown —
against −0.58 SOL for the momentum variant on the same slice.

Deterministic: no clock, no randomness, no environment reads.

## Run

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout (Node 22)
```

`main.ts` is the entrypoint; the strategy lives in `strategy.ts`;
`vendor/makefun-bot.ts` is the kit's zero-dependency replay shim, vendored
byte for byte.

## License

MIT — see [LICENSE](LICENSE).
