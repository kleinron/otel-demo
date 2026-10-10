# Architecture

This is an observability experiment shaped like an electronics store. The service boundaries below are fixed. Each service answers `GET /health`, and business behavior is not implemented yet.

## Services and data

Four processes. The CDK app gives each one its own private PostgreSQL instance. No service reads another service's tables. The processes themselves are still health endpoints.

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

Process configuration comes from environment variables. Provider-specific code is allowed only under `infra/<provider>/`. `infra/aws/` holds the CDK demo stack, the experiment tag, the teardown command, and the deploy guard. Application packages do not import a cloud SDK.

The demo runs in eu-central-1. Tasks are small public Fargate tasks so they can reach ECR and CloudWatch without a NAT gateway. Databases sit on isolated subnets. Shop traffic from the load generator uses an internal load balancer. An ADOT sidecar sends OTLP to CloudWatch metrics, X-Ray, and CloudWatch Logs, and keeps checkout, payment, delivery, errors, slow traces, and fault-tagged traces while sampling browse and cart. Grafana is one more small task. Its HTTPS load balancer security group starts with no inbound rules. Alerts exist only as Grafana rules generated from `observability/alerts.yml`. Database backups are off.

## Telemetry

Shared instrumentation lives in `packages/telemetry`. See [telemetry.md](telemetry.md).
