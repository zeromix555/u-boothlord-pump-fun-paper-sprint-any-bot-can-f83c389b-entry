[![make.fun · Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zeromix555/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zeromix555/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Momentum Rider — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. The house replays it on 6 hours of real pump.fun market data; highest net PnL wins. No real money.

## Strategy

Most new pump.fun curves are noise. The ones worth riding show real,
broad-based buy pressure over a short window: several distinct wallets
buying, net SOL flowing in and accelerating, price climbing and holding near
its window high. The bot:

- **Enters small** (0.05 SOL) once a curve is mature (240+ slots old), with
  net buy flow ≥ 0.8 SOL over a 40-slot window, ≥ 4 distinct buyers, price
  up 4–120% and within 4% of its window high, and real SOL between 1 and 80.
- **Pyramids into strength only** — adds 0.15 SOL per step (up to 1 SOL per
  position) while the price is at or above the last buy's price, the position
  is up, and net SOL still flows in.
- **Exits** on a 15% stop loss, a 25% trailing stop (armed at +10%), a fade
  in flow (net SOL < −1 over 20 slots), any single sell ≥ 5 SOL, or a 1500-slot
  time limit.
- **Paces itself** with tiny 0.02 SOL probe round trips so the run clears the
  guardrail bar (round trips ≥ 0.01 SOL on ≥ 20 coins).

Deterministic: no clock, no randomness, no environment reads.

## Run

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout (Node 22)
```

`main.ts` is the whole strategy; `vendor/makefun-bot.ts` is the kit's
zero-dependency replay shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
