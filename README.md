# otel-demo

Observability experiment: a small electronics store, fully instrumented, with cloud-specific code kept out of the services. A checkout is one order that moves `cart -> reserved -> paid -> handed_to_delivery`, and one successful checkout is one W3C trace across shop, inventory, payment, and delivery. The AWS demo stack is CDK in `infra/aws`. This repository synthesizes and tests that stack. It does not deploy it.

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
packages/telemetry     OpenTelemetry Node SDK, JSON logs, HTTP and outbound metrics, fault control
packages/db            Postgres client used by each service for its own database
packages/httpkit       Server spans, W3C traceparent client, listen helpers
services/shop          cart, checkout, order status
services/inventory     catalog, warehouse stock, reserve and release
services/payment       dummy charges: authorized, captured, declined, unknown
services/delivery      handoff, packaging, shipped
loadgen                open-loop shop load, fixed arrival rate, UTC spikes
infra/aws              CDK demo stack, teardown, deploy guard, SSM fault-switch reader
infra/gcp              GCP spike: Terraform for one Cloud Run service, pluggable fault switch
docs                   architecture, telemetry, and teardown runbook
docker-compose.yml     local Postgres and the four services
```

`results/` and `raw/` are local experiment output and are gitignored.

## AWS safety tooling

The demo stack and the teardown command both live in `infra/aws`. The only experiment tag is `experiment=otel-demo`. The Budgets alert `otel-demo-experiment` is allow-listed by name and is not deleted; Ron deletes it by hand after the experiment is fully finished. Database backups are off.

```bash
npm run teardown -- --dry-run
npm run teardown -- --region eu-central-1
EXPERIMENT_HARD_STOP_UTC=2026-10-17T00:00:00Z npm run deploy:check
```

Runbook: [docs/teardown.md](docs/teardown.md). Tag contract and stack: [infra/aws/README.md](infra/aws/README.md).

## Run the demo stack

CI runs `cdk synth`. Nothing in this repository creates AWS resources.

```bash
npm run synth -w @otel-demo/infra-aws
```

An operator deploy, from `infra/aws`, exports the experiment start and then deploys:

```bash
export LOADGEN_START_UTC=<experiment start>
npx cdk deploy --region eu-central-1
```

Any `cdk deploy` must export `LOADGEN_START_UTC` to that run's experiment start (ISO-8601 UTC). CDK writes the value onto every service task and the load generator task, so the deploy keeps the experiment start. When the variable is unset, those tasks use `experiment.start` from `loadgen/schedule.json`. The start is a runtime value. Leave it out of the stack source.

Build the service image and push the `demo` tag to each ECR repository (`otel-demo/shop`, `otel-demo/inventory`, `otel-demo/payment`, `otel-demo/delivery`, and `otel-demo/loadgen`) before that deploy. Synth does not build images.

```bash
npm run image:build
```

That script runs `docker build --platform linux/arm64 -f infra/aws/docker/service.Dockerfile`. Images must be built with `--platform linux/arm64`. Fargate tasks are ARM. The Dockerfile rejects any other architecture. An x86 build fails at task start with `exec format error` and the ECS deployment rolls back. The image includes `loadgen/schedule.json` at `/app/loadgen/schedule.json`. Service tasks set `OTEL_DEMO_LOAD_SCHEDULE_FILE` to that path so scheduled fault windows can fire inside the services.

After the first deploy, seed reference data before any checkout traffic. Payment and delivery create their tables when those tasks start. Shop customers and inventory stock are loaded by one-off Fargate tasks that use the deployed task definitions, replace the app command with the seed program, and then stop:

```bash
npm run seed:aws
```

That is a required step after the first deploy. The seed program drops the shop and inventory tables and loads the reference data again. Run it again only when that data should be rebuilt. Do not run it during a live experiment: it deletes shop orders. The `demo` image has to include `services/shop/dist/seed-main.js`, `services/inventory/dist/seed-main.js`, and `services/inventory/dist/restock-main.js`, so push that image before seeding. The task entrypoint builds `DATABASE_URL` from the task's database settings, then starts the seed program. Region defaults to `eu-central-1` (`AWS_REGION` or `EXPERIMENT_REGION` override it). The command names the cluster `otel-demo` and the services `otel-demo-shop` and `otel-demo-inventory`.

If checkouts start returning `out_of_stock` because regular SKUs are exhausted, top the inventory back up without touching orders:

```bash
npm run restock:aws
```

That runs only `services/inventory/dist/restock-main.js` on the deployed inventory task. Available stock (`on_hand - reserved`) returns to the seed target. Reservations stay. Running it twice writes the same on-hand counts when nothing new has been reserved. Locally, with `INVENTORY_DATABASE_URL` set, the same program is `npm run restock`.

The load generator service is created with desired count 0. A later `cdk deploy` rolls a generator that is already running, and that roll starts a new task. After any `cdk deploy`, run this first when the runner should stay stopped:

```bash
npm run loadgen:stop
```

Start it for a run and stop it when the run is over:

```bash
npm run loadgen:start
npm run loadgen:stop
```

Those set the `otel-demo-loadgen` desired count to 1 and 0.

Scheduled faults fire only when the SSM parameter `/otel-demo/faults-enabled` is `on`. `off` is the emergency stop. The stack creates the parameter as `off`. Each service polls that parameter (`FAULT_SWITCH_SOURCE=module`, module `/opt/fault-switch/fault-switch.cjs`, name from `OTEL_DEMO_FAULTS_PARAMETER`) and applies only the `loadgen/schedule.json` windows for its own operations. Turning the parameter `on` takes effect on the next poll, without a new deploy. A service logs `fault schedule loaded` at startup, then `fault window start` and `fault window end`. An injected fault is `fault.injected` on the span and the access log. The schedule file in the image is `/app/loadgen/schedule.json`; if that file is missing, the service fails at startup.

Grafana is plain HTTP on port 3000. The task is in a public subnet and has a public address. Its security group is created with no inbound rules. After every deploy, including a redeploy, add your address on port 3000 to the group in the `GrafanaSecurityGroupId` output. The group does not keep that rule across a redeploy. The task address changes when the task restarts. With credentials in the environment:

```bash
npm run grafana:url
```

That prints the current address as `http://<address>:3000`. Plain HTTP is acceptable for this throwaway demo. The generated admin password lives only in Secrets Manager (`otel-demo/grafana-admin`) and is not used anywhere else. Do not copy it into the repo, a log, or a pull request. Anonymous access and sign-up are off. Grafana being unreachable is not data loss: metrics, logs, and traces stay in CloudWatch and X-Ray, and alert state lines stay in `/otel-demo/alerts`.

Shop traffic from the load generator still uses the internal load balancer. That balancer has no public address.

Database backups are off: retention is 0 days, deletion protection is off, and destroy does not take a final snapshot.

Cost follows the no-NAT ARM column in the SRE estimate, [docs/cost-estimate.md](docs/cost-estimate.md). The stack adds no NAT gateway, no public Grafana load balancer, and no CloudWatch alarms. Grafana's public IPv4 is the task address. Backup retention 0 keeps the backup line at $0. The databases are PostgreSQL, and Secrets Manager holds four database passwords plus the Grafana admin password; the tables price one secret and a MySQL row.

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

`npm test` runs Vitest for the telemetry package, service behavior, the seed rebuild, a checkout trace that spans all four services, and the load generator schedule. The trace test also drops `traceparent` on each hop and expects the trace to split. Tests use in-process Postgres, so they do not need Docker. `npm run build` compiles the workspaces with TypeScript project references.

## Local databases

`docker compose up --build` starts Postgres and the four services. Each service has its own database and talks to the others over HTTP. Seed reference data after Postgres is healthy:

```bash
docker compose up -d postgres
SHOP_DATABASE_URL=postgres://otel@localhost:5432/shop \
INVENTORY_DATABASE_URL=postgres://otel@localhost:5432/inventory \
PAYMENT_DATABASE_URL=postgres://otel@localhost:5432/payment \
DELIVERY_DATABASE_URL=postgres://otel@localhost:5432/delivery \
npm run seed
```

`npm run seed` drops and recreates each service schema, then inserts 1000 deterministic Israeli customers, the electronics catalog, and warehouse stock. Running it again replaces a partially filled database with that same data. The Postgres container trusts local connections; do not reuse that setting outside this compose file.

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

## Load

`loadgen/` plays browse, cart, checkout, and order-status flows against shop at a fixed arrival rate. The plan is `loadgen/schedule.json`. See [loadgen/README.md](loadgen/README.md).

```bash
npm run build
SHOP_URL=http://localhost:3001 npm run start -w @otel-demo/loadgen
```

## Secrets

This repository is public. Do not commit secrets, AWS account ids, ARNs, or IP addresses.

`.gitignore` excludes `.env*`, `results/`, `raw/`, `node_modules/`, `dist/`, `cdk.out/`, `.aws/`, and `*.pem`. Pull requests run gitleaks (`.github/workflows/secret-scan.yml`) with those extra rules. Build and test run in `.github/workflows/ci.yml`.
