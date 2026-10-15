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
docker-compose.yml     local Postgres, the four services, and the collector
otel/                  collector configs (debug, and Logz.io when selected)
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

Postgres data lives on the `postgres-data` volume. A restart or `docker compose down` keeps it. `docker compose down -v` is what deletes it. Seed does not run on container start.

## Run locally with Logz.io

Local compose sends every service's traces, metrics, and logs to an OpenTelemetry collector. The collector can print them, or forward them to Logz.io when you give it tokens. Nothing is sampled.

### Prerequisites

- Docker with Compose v2.
- Node.js 22 and `npm install` at the repo root. `npm run seed` runs on the host, not in a container.
- A Logz.io account only if you want the data to leave the machine. With the tokens left empty, the collector still starts and its debug exporter prints traces, logs, and metrics.

### Configure

```bash
cp .env.example .env
```

Compose reads `.env` for the collector and the load rate. `.env` is gitignored. `.env.example` is the only env file that belongs in git, and it has placeholders. This repository is public. Do not commit real tokens, and do not paste them into a pull request or a log.

In Logz.io, open the gear menu, then Settings, then Manage tokens, then Data shipping tokens:

| Token                  | Settings tab | Env var                |
| ---------------------- | ------------ | ---------------------- |
| Tracing shipping token | Tracing      | `LOGZIO_TRACING_TOKEN` |
| Logs shipping token    | Logs         | `LOGZIO_LOGS_TOKEN`    |
| Metrics shipping token | Metrics      | `LOGZIO_METRICS_TOKEN` |

The listener host is on that same page, and in the account region table (Settings, or the Logz.io regions page). The region code is `us`, `eu`, `au`, `ca`, `uk`, `nl`, or `wa`. Set `LOGZIO_REGION` to that code.

Traces and logs use the OTLP listener, which is the bare host on port 443. The collector appends `/v1/traces` and `/v1/logs`. Port `:4318` does not answer. Metrics use the Prometheus listener on port `8053`. The US hosts have no region suffix. Every other region inserts the code: `otlp-listener-<region>.logz.io` and `listener-<region>.logz.io`.

| Region | `LOGZIO_TRACES_ENDPOINT` and `LOGZIO_LOGS_ENDPOINT` | `LOGZIO_METRICS_ENDPOINT`          |
| ------ | --------------------------------------------------- | ---------------------------------- |
| us     | `https://otlp-listener.logz.io`                     | `https://listener.logz.io:8053`    |
| eu     | `https://otlp-listener-eu.logz.io`                  | `https://listener-eu.logz.io:8053` |
| au     | `https://otlp-listener-au.logz.io`                  | `https://listener-au.logz.io:8053` |
| ca     | `https://otlp-listener-ca.logz.io`                  | `https://listener-ca.logz.io:8053` |
| uk     | `https://otlp-listener-uk.logz.io`                  | `https://listener-uk.logz.io:8053` |
| nl     | `https://otlp-listener-nl.logz.io`                  | `https://listener-nl.logz.io:8053` |
| wa     | `https://otlp-listener-wa.logz.io`                  | `https://listener-wa.logz.io:8053` |

`.env.example` fills in the US hosts. An EU account uses the `eu` row.

Two collector configs, both in the repo:

- `otel/collector.yaml` is the default (`OTEL_COLLECTOR_CONFIG=/etc/otelcol-contrib/config.yaml`). It receives OTLP gRPC on `:4317` and OTLP HTTP on `:4318` (every interface; collector 0.128 would otherwise bind localhost, which the other containers cannot reach), and exports only to the debug exporter. No tokens.
- `otel/collector-logzio.yaml` keeps that debug exporter and adds Logz.io. After the three tokens are filled, set `OTEL_COLLECTOR_CONFIG=/etc/otelcol-contrib/collector-logzio.yaml`.

Traces and logs go to Logz.io over OTLP/HTTP. Metrics go via `prometheusremotewrite`. Each trace and log exporter has `retry_on_failure` (it keeps retrying: `max_elapsed_time` is 0) and a `sending_queue` stored with `file_storage` on the `otel-collector-queue` volume. A flaky connection does not drop spans that have already reached the collector. The Prometheus remote-write exporter does not accept `sending_queue` or `file_storage`. It uses `retry_on_failure`, `remote_write_queue`, and a write-ahead log on that same volume.

The collector image runs as uid 10001, which cannot create files on a fresh named volume. A one-shot init container creates the queue directories and hands them to that user. The collector process is not root. The image also has no shell, so a small busybox container shares its network and is the healthcheck the services wait for (`http://localhost:13133`).

There is no sampling processor. The services use an AlwaysOn sampler. At this rate, every span is kept.

### Commands

Start Postgres, the collector, and the four services. The load generator stays off until you ask for it.

```bash
docker compose up -d --build
```

Wait until the services are healthy (`docker compose ps`). Then seed. This drops and recreates shop and inventory data. It is not part of container startup, so a later restart does not wipe orders. Run it again only when you want that data rebuilt.

```bash
SHOP_DATABASE_URL=postgres://otel@localhost:5432/shop \
INVENTORY_DATABASE_URL=postgres://otel@localhost:5432/inventory \
PAYMENT_DATABASE_URL=postgres://otel@localhost:5432/payment \
DELIVERY_DATABASE_URL=postgres://otel@localhost:5432/delivery \
npm run seed
```

Start the load. The default is one cart activity per minute, spaced evenly, with browse, checkout, and order-status in the same proportion as `loadgen/schedule.json` (about 3 checkouts per 100 cart activities, so every hour includes a checkout). Each local cart activity adds an item, and about 30% of them then remove that line. A checkout is its own flow: a new cart, an add, then payment and delivery. Change `LOADGEN_CARTS_PER_MINUTE` in `.env` to pick another rate. That variable is read only by the load generator. AWS and GCP tasks do not set it, and the services do not read it, so the cloud schedule and its fault windows stay as they are. Local mode flattens the day-night curve and does not pause for warm-up or spike multipliers. A late wake still emits the seconds it missed, so a stall does not thin the hour out. It runs for 72 hours from the process start (the same hard cap as the experiment), then stops. Start the container again to continue. `LOADGEN_START_UTC` still pins the start when you set it, for both the generator and the services.

```bash
docker compose --profile load up -d loadgen
```

Stop the load generator:

```bash
docker compose --profile load stop loadgen
```

Stop the stack and keep Postgres data and the collector queue:

```bash
docker compose --profile load down
```

Full reset. This deletes the `postgres-data` and `otel-collector-queue` volumes. The next `up` starts from empty databases, and seed is required again before checkouts.

```bash
docker compose --profile load down -v
```

Services, the collector, and the load generator use `restart: unless-stopped`.

### Verify

Without tokens, the debug exporter is the whole pipeline:

```bash
docker compose logs otel-collector
```

Traces, logs, and metrics from `shop`, `inventory`, `payment`, and `delivery` should show up. Each service's `service.name` is that short name. Log records carry `trace_id` and `span_id`. On GCP the same correlation is `logging.googleapis.com/trace` and `logging.googleapis.com/spanId` in Cloud Logging. Locally the stdout line keeps `trace_id` and `span_id`, and the OTLP log record's span context is those ids, which is what Logz.io uses to open the trace from a log. The open-loop load generator writes JSON to its own stdout and does not export OTLP. Its compose service still sets `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME=loadgen` for a traced entrypoint (`LOADGEN_TRACING=on` on the cart-tick command).

Collector self-metrics listen on port 8888 inside the compose network (`detailed` level, every interface). They are not published on the host. From a service container:

```bash
docker compose exec shop node -e "fetch('http://otel-collector:8888/metrics').then((r)=>r.text()).then((t)=>console.log(t))"
```

`otelcol_exporter_sent_spans_total`, `otelcol_exporter_sent_log_records_total`, and `otelcol_exporter_sent_metric_points_total` count batches the exporter accepted. `otelcol_exporter_send_failed_spans_total` and the matching `send_failed` series for log records and metric points count exports that failed. The label `exporter` is `debug` or the Logz.io exporter id (`otlphttp/logzio_traces`, `otlphttp/logzio_logs`, `prometheusremotewrite/logzio`). Sent climbing and send_failed staying put means that exporter is delivering. send_failed climbing means the listener, the token, or the port is wrong. The debug exporter's sent count should move even with no tokens.

With the Logz.io config and tokens:

- Tracing: filter `service.name` to `shop`, `inventory`, `payment`, and `delivery`. One checkout is one trace across all four. Nothing is sampled out.
- Logs: open a line and confirm `trace_id` and `span_id`. That trace id should exist in Tracing.
- Metrics: names do not have the GCP `workload.googleapis.com/` prefix (PromQL `workload_googleapis_com:`). See [observability/README.md](observability/README.md).
- Collector: the same `otelcol_exporter_sent_*` series for `otlphttp/logzio_traces` and `prometheusremotewrite/logzio` should increase, and `otelcol_exporter_send_failed_*` should not.

### How much data

At 1 cart per minute the other streams stay in proportion to the checked-in plan, which is about 1.44% of its 100,000 cart activities per day. The 72-hour experiment's planning figure is about 1 million traces. Scaled to this rate and counted as spans, expect about 86,000 spans per day. The collector keeps every one. Compose probes `/ready` every 5 seconds. That is one HTTP span plus a `SELECT 1`, smaller than the cart traffic.

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

Point traces, metrics, and (when `OTEL_LOGS_EXPORTER=otlp`) logs at a collector with `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). The exporter is OTLP/HTTP. Logs are JSON on stdout and include `trace_id`, `span_id`, an X-Ray-format trace id, `service`, and `orderId` when the request has one. Compose sets the endpoint to `http://otel-collector:4318` and turns OTLP logs on. Leave `OTEL_LOGS_EXPORTER` unset on AWS and GCP. Those paths keep stdout logs.

## Load

`loadgen/` plays browse, cart, checkout, and order-status flows against shop at a fixed arrival rate. The plan is `loadgen/schedule.json`. See [loadgen/README.md](loadgen/README.md).

```bash
npm run build
SHOP_URL=http://localhost:3001 npm run start -w @otel-demo/loadgen
```

## Secrets

This repository is public. Do not commit secrets, AWS account ids, ARNs, or IP addresses.

`.gitignore` excludes `.env*` except the placeholder `.env.example`, plus `results/`, `raw/`, `node_modules/`, `dist/`, `cdk.out/`, `.aws/`, and `*.pem`. Pull requests run gitleaks (`.github/workflows/secret-scan.yml`) with those extra rules. Build and test run in `.github/workflows/ci.yml`.
