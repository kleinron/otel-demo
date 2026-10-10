# Architecture

This is an observability experiment shaped like an electronics store. The service boundaries below are fixed. Each service answers `GET /health` and owns the behavior described here.

## Services and data

Four processes. Each one will own its own database (its own RDS instance once AWS infrastructure exists). No service reads another service's tables.

| Service     | Role                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------- |
| `shop`      | Storefront and order orchestration. Owns carts, customers, and the order state machine.      |
| `inventory` | Catalog and warehouse stock for electronics SKUs. Reserve and release stay in this database. |
| `payment`   | Dummy payment provider. A charge is `authorized`, `captured`, `declined`, or `unknown`.      |
| `delivery`  | Accepts a paid order, then moves it `accepted -> packaging -> shipped`.                      |

## Order state

`shop` is the only writer of order state:

```text
cart -> reserved -> paid -> handed_to_delivery
```

## Calls between services

Calls are synchronous HTTP. A mutating call carries an idempotency key, and that key is the `orderId`. The same key is the `orderId` field on logs when the request is handling an order. Shop sends that key on reserve, charge, capture, and handoff. Replaying checkout with the same key resumes from the last stored status instead of reserving or charging again. An outbound call that exceeds `OUTBOUND_TIMEOUT_MS` leaves the order in a retryable status (`payment_unknown` or `delivery_pending`).

`payment` stores one row per `orderId`. The first charge waits `PAYMENT_LATENCY_MS` and records `authorized` unless the body asks for `declined` or `unknown`. Capture moves `authorized` to `captured`. A replay returns the stored row and does not create a second charge.

An inventory reserve that cannot be filled is a business outcome: HTTP 409, out of stock. That response is not a server error. The checkout trace is still marked with error status so the failed order is visible. Stock is allocated from warehouses in stable warehouse-id order and written only in the inventory database.

Reference data is loaded by `npm run seed`: 1000 deterministic customers (English and Hebrew names, Israeli cities, `+972` phone numbers with separators) in the shop database, and the smartphone, headphone, power bank, and laptop catalog with warehouse stock in the inventory database. Seed drops the service tables first, so a partially filled database is rebuilt.

## Configuration

Process configuration comes from environment variables. Provider-specific code is allowed only under `infra/<provider>/`. `infra/aws/` holds the experiment tag, the teardown command, and the deploy guard. It does not yet define the ECS or RDS stacks. Application packages do not import a cloud SDK.

## Telemetry

Shared instrumentation lives in `packages/telemetry`. See [telemetry.md](telemetry.md).
