# otel-demo

Observability experiment: a small electronics store, fully instrumented, with cloud-specific code kept out of the services. This phase is the TypeScript skeleton and the shared telemetry package. Order, stock, payment, and delivery behavior are not implemented yet, and there is no AWS infrastructure.

## Architecture

Four services. Each one will have its own database. `shop` owns the order:

```text
cart -> reserved -> paid -> handed_to_delivery
```

Services will call each other with synchronous HTTP. The idempotency key is the `orderId`. `payment` is a dummy provider: charges are idempotent, and a charge status is `authorized`, `captured`, `failed`, or `refunded`. An out-of-stock reserve is HTTP 409 and is a business outcome, not a server error.

Configuration comes from environment variables. Provider-specific code belongs only under `infra/<provider>/`.

Details: [docs/architecture.md](docs/architecture.md). Instrumentation: [docs/telemetry.md](docs/telemetry.md).

## Layout

```text
packages/telemetry     OpenTelemetry Node SDK, JSON logs, HTTP metrics
services/shop          order orchestration (health endpoint only)
services/inventory     stock (health endpoint only)
services/payment       dummy payment provider (health endpoint only)
services/delivery      delivery handoff (health endpoint only)
loadgen                placeholder for later scenarios
infra/aws              experiment tag, teardown, and deploy guard
docs                   architecture, telemetry, and teardown runbook
```

`results/` and `raw/` are local experiment output and are gitignored.

## AWS safety tooling

No ECS or RDS stack is created from this repo yet. Before one is, the teardown and deploy guard in `infra/aws` are the gate. The only experiment tag is `experiment=otel-demo`. The Budgets alert `otel-demo-experiment` is allow-listed by name and is not deleted; Ron deletes it by hand after the experiment is fully finished.

```bash
npm run teardown -- --dry-run
npm run teardown -- --region eu-central-1
EXPERIMENT_HARD_STOP_UTC=2026-10-17T00:00:00Z npm run deploy:check
```

Runbook: [docs/teardown.md](docs/teardown.md). Tag contract: [infra/aws/README.md](infra/aws/README.md).

## Requirements

Node.js 22 (see `.nvmrc`).

## Tests and build

```bash
npm install
npm test
npm run build
npm run lint
npm run format:check
```

`npm test` runs Vitest for the telemetry package, the four service health checks, and the loadgen placeholder. `npm run build` compiles the workspaces with TypeScript project references.

## Run a service

```bash
npm run build
OTEL_SDK_DISABLED=true npm run start -w @otel-demo/shop
```

Health checks:

| Service   | URL                            |
| --------- | ------------------------------ |
| shop      | `http://localhost:3001/health` |
| inventory | `http://localhost:3002/health` |
| payment   | `http://localhost:3003/health` |
| delivery  | `http://localhost:3004/health` |

Point traces and metrics at a collector with `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). The exporter is OTLP/HTTP. Logs are JSON on stdout and include `trace_id`, `span_id`, an X-Ray-format trace id, `service`, and `orderId` when the request has one.

## Secrets

This repository is public. Do not commit secrets, AWS account ids, ARNs, or IP addresses.

`.gitignore` excludes `.env*`, `results/`, `raw/`, `node_modules/`, `dist/`, `cdk.out/`, `.aws/`, and `*.pem`. Pull requests run gitleaks (`.github/workflows/secret-scan.yml`) with those extra rules. Build and test run in `.github/workflows/ci.yml`.
