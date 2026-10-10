# Observability alerts

[`alerts.yml`](alerts.yml) is the provider-neutral alert catalog for this experiment. Each entry is one alert. Thresholds are initial values to tune after baseline traffic.

Another engineer owns the AWS CDK app in `infra/aws`. That app generates the deployed alarms from this file. This directory does not define infrastructure.

Customer-facing 5xx alerts cover add-to-cart, remove-from-cart, checkout, and order status. The 5xx numerator is HTTP 500–599. Allocation conflicts return HTTP 409 and are only on the informational per-SKU-category alerts, so they do not contribute to the 5xx alarms. Informational severity must not page. The `experiment-budget` entry is an AWS Budgets alert (`retain_on_teardown: true`), not an application metric, and teardown leaves it in place. See [teardown-checklist.md](teardown-checklist.md).

Faults run in scheduled windows (for example about 10 minutes at high probability every few hours). Each window logs start and end markers, so alerts are expected to fire during those windows. Thresholds remain initial values to tune.

## Fields

| Field                | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | Stable id. The generator uses it as the alarm name.                                                                                                                                      |
| `signal`             | `metric`, `log`, or `trace`. This first catalog is all metrics. A log entry becomes a log-derived metric before it alarms. A trace entry becomes a span-derived metric before it alarms. |
| `scope`              | `service` and `operation` the alert covers.                                                                                                                                              |
| `group_by`           | Optional label. Present on the inventory rates so they split by SKU category.                                                                                                            |
| `condition`          | What is compared with the threshold.                                                                                                                                                     |
| `threshold`          | Initial trip point. Numeric caps for the load generator, and the budget amount, live in their own configuration.                                                                         |
| `window`             | Total evaluation window. The generator chooses periods that cover it.                                                                                                                    |
| `min_request_count`  | Optional. The alarm cannot fire unless the window has at least this many requests. CDK and GCP generators implement it with a metric-math condition on the request count.                |
| `severity`           | `critical`, `warning`, or `informational`.                                                                                                                                               |
| `why`                | One sentence, copied into the alarm description.                                                                                                                                         |
| `retain_on_teardown` | Optional. Set only on the budget alert.                                                                                                                                                  |

`window: 5m` on a ratio or a p99 is a five-minute rate or percentile, not five isolated minutes that each have to breach. p99 is the 99th percentile of server-side latency for that operation.

## AWS

The workload runs in eu-central-1: shop, inventory, payment, and delivery on ECS Fargate, each with its own RDS, plus a load generator. ADOT exports metrics and logs to CloudWatch and traces to X-Ray. CDK should map this file roughly as follows:

| Catalog                | CloudWatch / billing                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `signal: metric`       | Metric alarm on the ADOT / EMF series                                           |
| `signal: log`          | Logs metric filter, then a metric alarm                                         |
| `signal: trace`        | Span metric or X-Ray alarm, then a metric alarm                                 |
| `scope`                | Dimensions for service and operation                                            |
| `group_by`             | Extra dimension                                                                 |
| `threshold` + `window` | Threshold, period, and evaluation periods                                       |
| `severity`             | Alarm action. `informational` does not page                                     |
| `why`                  | Alarm description                                                               |
| `experiment-budget`    | AWS Budgets notification for actual or forecasted spend. Not a CloudWatch alarm |

## GCP, if the experiment moves

Keep this file. Replace the generator, not the catalog. ADOT (or another OpenTelemetry collector) would export to Cloud Monitoring, Cloud Logging, and Cloud Trace instead of CloudWatch and X-Ray.

| Catalog                  | GCP                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `signal: metric`         | Cloud Monitoring alerting policy, threshold condition                                                                   |
| `signal: log`            | Log-based metric, then an alerting policy                                                                               |
| `signal: trace`          | Cloud Trace span metric, then an alerting policy                                                                        |
| `scope`                  | Labels such as `service` and `operation`                                                                                |
| `group_by: sku_category` | Group-by on that label. Severity stays informational                                                                    |
| p99                      | `ALIGN_PERCENTILE_99` over the same window                                                                              |
| 5xx ratio                | A ratio condition whose numerator is HTTP 500–599. HTTP 409 stays on the allocation-conflict policy                     |
| `severity`               | Notification channel. Informational policies do not page                                                                |
| `why`                    | Policy documentation                                                                                                    |
| `experiment-budget`      | Cloud Billing budget at the same percentage of the configured experiment budget, retained after the workload is deleted |
