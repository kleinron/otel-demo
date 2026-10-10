# Observability alerts

[`alerts.yml`](alerts.yml) is the provider-neutral alert catalog for this experiment. Each entry is one alert. Thresholds are initial values to tune after baseline traffic.

Alerts are defined in one place: Grafana, self-hosted on a small Fargate task, to avoid vendor lock-in. Data sources are CloudWatch Logs, CloudWatch metrics, and X-Ray. CloudWatch alarms are not generated. A generator produces Grafana alert-rule provisioning files from this catalog. Another engineer owns that generator. This directory does not define infrastructure.

Nothing outside Grafana watches Grafana itself, so a Grafana outage is not alerted. That gap is deliberate because of the one-place rule.

Customer-facing 5xx alerts cover add-to-cart, remove-from-cart, checkout, and order status. The 5xx numerator is HTTP 500–599. Allocation conflicts return HTTP 409 and are only on the informational per-SKU-category alerts, so they do not contribute to the 5xx rules. Informational severity must not page: it routes to a no-page contact point. The `experiment-budget` entry is an AWS Budgets alert (`retain_on_teardown: true`), not a Grafana rule, and teardown leaves it in place. See [teardown-checklist.md](teardown-checklist.md).

Faults run in scheduled windows (for example about 10 minutes at high probability every few hours). Each window logs start and end markers, so alerts are expected to enter Alerting (Firing) during those windows. Thresholds remain initial values to tune.

The spike schedule and the alert each spike is expected to fire are in [expected-alarms.md](expected-alarms.md).

## Fields

| Field                | Meaning                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | Stable id. The generator uses it as the Grafana alert rule name.                                                                                                                                                  |
| `signal`             | `metric`, `log`, or `trace`. This first catalog is all metrics. A log entry is a query on the CloudWatch Logs data source. A trace entry is a query on the X-Ray data source.                                     |
| `scope`              | `service` and `operation` the alert covers. Every rule carries a `service` label.                                                                                                                                 |
| `group_by`           | Optional label. Present on the inventory rates so they split by SKU category.                                                                                                                                     |
| `condition`          | What is compared with the threshold.                                                                                                                                                                              |
| `threshold`          | Initial trip point. Numeric caps for the load generator, and the budget amount, live in their own configuration.                                                                                                  |
| `window`             | Total evaluation window. Maps to the Grafana evaluation range and to `for`.                                                                                                                                       |
| `min_request_count`  | Optional. The rule cannot enter Alerting unless the window has at least this many requests. The generator adds a math or threshold expression on the request-count query and combines it with the rule condition. |
| `missing_data`       | Optional. `not_breaching` sets `noDataState` to OK. `breaching` sets `noDataState` to Alerting.                                                                                                                   |
| `severity`           | `critical`, `warning`, or `informational`. Copied to the `severity` label. Informational routes to a no-page contact point.                                                                                       |
| `why`                | One sentence, copied into the summary annotation.                                                                                                                                                                 |
| `retain_on_teardown` | Optional. Set only on the budget alert.                                                                                                                                                                           |

`window: 5m` on a ratio or a p99 is a five-minute rate or percentile, not five isolated minutes that each have to breach. p99 is the 99th percentile of server-side latency for that operation.

## Grafana

The workload runs in eu-central-1: shop, inventory, payment, and delivery on ECS Fargate, each with its own RDS, plus a load generator. ADOT exports metrics and logs to CloudWatch and traces to X-Ray. Grafana runs on its own small Fargate task and uses those three as data sources. A generator produces Grafana alert-rule provisioning files from this catalog:

| Catalog                       | Grafana alert rule                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `signal: metric`              | Query on the CloudWatch metrics data source (the ADOT / EMF series)                            |
| `signal: log`                 | Query on the CloudWatch Logs data source                                                       |
| `signal: trace`               | Query on the X-Ray data source                                                                 |
| `scope`                       | `service` label, and `operation` on the query. Every alert has labels `service` and `severity` |
| `group_by`                    | Extra grouping on the query                                                                    |
| `window`                      | Evaluation range and `for`                                                                     |
| `min_request_count`           | A math or threshold expression on the request-count query, combined with the rule condition    |
| `missing_data: not_breaching` | `noDataState: OK`                                                                              |
| `missing_data: breaching`     | `noDataState: Alerting`                                                                        |
| `threshold` + `condition`     | Rule condition                                                                                 |
| `severity`                    | `severity` label and the contact point. `informational` routes to a no-page contact point      |
| `why`                         | Summary annotation                                                                             |
| `experiment-budget`           | AWS Budgets notification for actual or forecasted spend. Not a Grafana alert rule              |

Grafana alert state history lives inside the Grafana task and is lost on restart. Every state change is also sent through a webhook contact point to a small logging endpoint, which writes a structured CloudWatch Logs line: event type `grafana_alert_state_change`, with the rule name, the previous state, the new state, and a timestamp in UTC. Teardown exports those lines and the provisioned rule files. See [teardown-checklist.md](teardown-checklist.md) and [expected-alarms.md](expected-alarms.md).

## GCP, if the experiment moves

Keep this file. The same catalog could target another Grafana data source set. ADOT (or another OpenTelemetry collector) would export to Cloud Monitoring, Cloud Logging, and Cloud Trace, and Grafana would use those data sources instead of CloudWatch and X-Ray. A generator produces Grafana alert-rule provisioning files either way.

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
