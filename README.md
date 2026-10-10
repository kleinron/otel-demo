# otel-demo

Observability experiment: a small electronics store, fully instrumented, with cloud-specific code kept out of the services. The services are still health endpoints. The AWS demo stack is CDK in `infra/aws`. Order, stock, payment, and delivery behavior are not implemented yet. This repository synthesizes and tests that stack. It does not deploy it.

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
infra/aws              CDK demo stack, experiment tag, teardown, and deploy guard
docs                   architecture, telemetry, and teardown runbook
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

An operator deploy, from `infra/aws`, is `npx cdk deploy --region eu-central-1`. Build each service image and push the `demo` tag to its ECR repository before that. Synth does not build images.

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
