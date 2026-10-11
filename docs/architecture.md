# Architecture

This is an observability experiment shaped like an electronics store. The service boundaries below are fixed. Each service answers `GET /health` and owns the behavior described here.

## Services and data

Four processes. Each one owns its own database. The CDK app gives each one a private PostgreSQL instance. No service reads another service's tables.

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

Reference data is loaded by `npm run seed`: 1000 deterministic customers (English and Hebrew names, Israeli cities, `+972` phone numbers with separators) in the shop database, and the smartphone, headphone, power bank, and laptop catalog with warehouse stock in the inventory database. Seed drops the service tables first, so a partially filled database is rebuilt. Regular SKUs are seeded with 700 units in each of the three warehouses, which covers the 72-hour checkout profile. `powerbank-dead-sea` stays at one unit in Tel Aviv. `npm run restock` (and `npm run restock:aws`) sets available stock back to those targets without dropping reservations or shop orders.

## Configuration

Process configuration comes from environment variables. Provider-specific code is allowed only under `infra/<provider>/`. `infra/aws/` holds the CDK demo stack, the experiment tag, the teardown command, and the deploy guard. Application packages do not import a cloud SDK.

The demo runs in eu-central-1. Tasks are small public Fargate tasks so they can reach ECR and CloudWatch without a NAT gateway. Databases sit on isolated subnets. Shop traffic from the load generator uses an internal load balancer. An ADOT sidecar on each task sends OTLP to CloudWatch metrics, X-Ray, and CloudWatch Logs. Every trace is exported. A sidecar decision cannot keep one checkout trace whole across shop, inventory, payment, and delivery, so the collector config has no tail sampling and keeps 100% of spans. X-Ray at about 1 million traces is a few dollars. Grafana is one more small task, plain HTTP on port 3000, with a security group that starts with no inbound rules. Plain HTTP is acceptable for this throwaway demo. The admin password is only in Secrets Manager and is not used anywhere else. Alerts exist only as Grafana rules generated from `observability/alerts.yml`. Database backups are off.

The load generator service is created with desired count 0. Shop and inventory reference data is loaded after deploy by `npm run seed:aws`. Payment and delivery migrate when their tasks start. During a run, `npm run restock:aws` tops up inventory on the deployed inventory task. It does not run the shop seed.

## Load

`loadgen` sends browse, cart, checkout, and order-status traffic to shop at a fixed arrival rate. The schedule, the Jerusalem day-night curve, and the fault windows are described in [loadgen/README.md](../loadgen/README.md).

## Telemetry

Shared instrumentation lives in `packages/telemetry`. See [telemetry.md](telemetry.md).
