# loadgen

Open-loop load against the shop API. Arrivals are scheduled from absolute UTC time, so a slow service does not lower the rate and a restarted process rejoins the curve instead of replaying a warm-up or a spike.

## Flows

Customers are the 1000 seeded ids `cust-0000` through `cust-0999`.

| Stream       | Shop calls                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| browse       | create a cart if needed, then `GET /carts/:cartId`                          |
| cart         | add or remove one line (`POST` or `DELETE` `/carts/:cartId/items`)          |
| checkout     | new cart, add items, `POST /carts/:cartId/checkout`, `GET /orders/:orderId` |
| order status | `GET /orders/:orderId` for an order this process has checked out            |

About 15% of checkouts ask for two `powerbank-dead-sea` units. That SKU has one unit on hand, so those attempts are out of stock.

The curve targets about 100k cart activities and 3k checkouts per day, plus browse and order-status traffic, shaped by the hour in `Asia/Jerusalem`. Spike minutes sit on top of that curve.

## Schedule

`schedule.json` is the checked-in plan. Every clock field names its zone.

- Experiment `2026-10-12T08:30:00Z` for 72 hours. Hard stop `2026-10-15T08:30:00Z`.
- Warm-up is the 5 minutes before the first spike (`09:55Z`–`10:00Z` on that plan). No shop traffic in that window.
- Spikes at 10:00, 12:00, 14:00, and 20:00 UTC, 20 minutes, multiplier 3.
- The first spike that falls inside the experiment is a normal baseline with no fault. On this plan that is 10:00 UTC on 12 October.
- Later spikes inject one fault at probability 1. The fault starts 2 minutes after the spike. Add-to-cart, inventory, and payment faults last 15 minutes. Checkout lasts 20.
- Day 2 is the next UTC date after the experiment start. The 12:00 UTC checkout spike that day uses multiplier 8.

| UTC   | Fault                                                                 |
| ----- | --------------------------------------------------------------------- |
| 10:00 | shop `add-to-cart` delay, 1200 ms                                     |
| 12:00 | shop `checkout` delay, 3000 ms                                        |
| 14:00 | inventory `database` timeout, 8000 ms (past the 5s statement timeout) |
| 20:00 | payment `charge` delay, 5000 ms (past the 2s shop payment timeout)    |

`LOADGEN_START_UTC` and `LOADGEN_SEED` override the file. Services must see the same values. The generator also refuses to run past 72 hours or above 60 arrivals/second. The schedule cap is 40/s, which is above the saturation peak.

## Run

```bash
npm run build
SHOP_URL=http://localhost:3001 npm run start -w @otel-demo/loadgen
```

`docker compose --profile load up --build` starts the generator next to the shop. Faults stay off until `OTEL_DEMO_FAULTS_ENABLED=true`. The services read the same `schedule.json` and apply whatever window is open, polling the kill switch the same way as a single-window schedule.

Each start logs `runner started` with `at` (UTC) and `seed`. Every request is one JSON line: `flowId`, `timestamp` (UTC), `operation`, `status`, `latencyMs`. Spike, warm-up, and fault markers use `spike start`, `spike end`, `warmup start`, `warmup end`, `fault window start`, and `fault window end`, with `at` set to the scheduled UTC boundary. A process that wakes up inside a window does not emit that window's start again.

On AWS the ECS service `otel-demo-loadgen` is deployed with desired count 0. `npm run loadgen:start` sets that count to 1 and `npm run loadgen:stop` sets it back to 0. Seed shop and inventory with `npm run seed:aws` before the first start. See the run section in the [root README](../README.md).
