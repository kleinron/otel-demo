# Architecture

This is an observability experiment shaped like an electronics store. The service boundaries below are fixed. Phase 1 only scaffolds them: each service answers `GET /health`, and business behavior is not implemented yet.

## Services and data

Four processes. Each one will own its own database (its own RDS instance once AWS infrastructure exists). No service reads another service's tables.

| Service     | Role                                                              |
| ----------- | ----------------------------------------------------------------- |
| `shop`      | Storefront and order orchestration. Owns the order state machine. |
| `inventory` | Stock for electronics SKUs.                                       |
| `payment`   | Dummy payment provider.                                           |
| `delivery`  | Hands a paid order to delivery.                                   |

## Order state

`shop` is the only writer of order state:

```text
cart -> reserved -> paid -> handed_to_delivery
```

## Calls between services

Calls are synchronous HTTP. A mutating call carries an idempotency key, and that key is the `orderId`. The same key is the `orderId` field on logs when the request is handling an order.

`payment` will accept idempotent charges. A charge status is one of `authorized`, `captured`, `failed`, or `refunded`.

An inventory reserve that cannot be filled is a business outcome: HTTP 409, out of stock. That response is not a server error.

## Configuration

Process configuration comes from environment variables. Provider-specific code is allowed only under `infra/<provider>/`. `infra/aws/` is a placeholder for later CDK. Application packages do not import a cloud SDK.

## Telemetry

Shared instrumentation lives in `packages/telemetry`. See [telemetry.md](telemetry.md).
