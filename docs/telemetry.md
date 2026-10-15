# Telemetry

`packages/telemetry` is provider-neutral. It configures the OpenTelemetry Node SDK with OTLP over HTTP (`http/protobuf`), propagates W3C `traceparent`, and does not import a cloud SDK or a vendor exporter (no X-Ray, Zipkin, Jaeger, Prometheus, or OTLP/gRPC).

Host resource detection is off. A machine address is not attached automatically. Set resource attributes explicitly.

## Export

| Variable                              | Role                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base URL. Signal paths `/v1/traces`, `/v1/metrics`, and `/v1/logs` are appended. Default `http://localhost:4318`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Full traces URL. Overrides the base.                                                                              |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL. Overrides the base.                                                                             |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | Full logs URL. Overrides the base. Used only when log export is on.                                               |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Shared `key=value` list. Signal-specific header variables override the same key.                                  |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`   | Extra traces headers.                                                                                             |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS`  | Extra metrics headers.                                                                                            |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`     | Extra logs headers.                                                                                               |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | Must be unset or `http/protobuf`, including the logs protocol variable.                                           |
| `OTEL_LOGS_EXPORTER`                  | `otlp` copies each JSON log line to the collector. Unset or `none` keeps stdout only.                             |
| `OTEL_METRIC_EXPORT_INTERVAL`         | Metric export interval in milliseconds, at least 1000. Unset keeps the SDK default of 60s.                        |
| `OTEL_SDK_DISABLED`                   | `true` skips SDK startup, including log export.                                                                   |

## Resource

| Variable                   | Attribute                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `OTEL_SERVICE_NAME`        | `service.name`. Overrides the name passed by the service.                                |
| `OTEL_SERVICE_VERSION`     | `service.version`.                                                                       |
| `DEPLOYMENT_ENVIRONMENT`   | `deployment.environment.name`, unless that key is already in `OTEL_RESOURCE_ATTRIBUTES`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra `key=value` resource attributes.                                                   |

`service.name` is required, from the service call or from `OTEL_SERVICE_NAME`.

## Logs

`createLogger({ service })` writes one JSON object per line through pino. The level is the `LOG_LEVEL` environment variable, read when the process creates the logger. The default is `info`. The demo tasks set `LOG_LEVEL=info` and `OTEL_LOG_LEVEL=error` so the lines that reach CloudWatch stay small. `LOG_LEVEL=debug` turns on `about to …` lines without rebuilding the image.

Present on every line: `service`, `level`, `msg`, `time`.

Present when a valid span is active: `trace_id`, `span_id`, and `xray_trace_id`. The X-Ray field is the encoding `1-{first 8 hex}-{last 24 hex}` of the W3C trace id. Export is still OTLP. `startTelemetry` installs the async context manager those fields are read from.

`LOG_FORMAT` and `CLOUD_PROVIDER` are read when the process creates the logger and the SDK. Unset, they keep the lines above and the AWS trace ids.

| Variable         | Unset / default                                                                                                    | `gcp`                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_FORMAT`     | `level`, `msg`, `trace_id`, `span_id`.                                                                             | `severity` (the Cloud Logging name, such as `INFO` or `WARNING`, never a number), `message`, `logging.googleapis.com/trace` = `projects/<GCP_PROJECT_ID>/traces/<trace id>`, `logging.googleapis.com/spanId`. `service` and `orderId` stay. |
| `CLOUD_PROVIDER` | `aws`. Trace ids use the X-Ray form (first 8 hex characters are unix seconds). The log line keeps `xray_trace_id`. | Standard W3C random trace ids (16 random bytes, no time prefix). The default log shape drops `xray_trace_id`.                                                                                                                               |

`GCP_PROJECT_ID` is the project id in the Cloud Logging trace field. It has to be a project id (lowercase letters, digits, hyphens). Without it, a `LOG_FORMAT=gcp` line still has `severity` and `message` but omits the trace link. See [gcp-spike.md](gcp-spike.md).

`OTEL_LOGS_EXPORTER=otlp` also sends each line to the collector as an OTLP log. The stdout line is unchanged. The log record's span context is the active span, or, if there is no active span, the `trace_id` and `span_id` on the line. A `LOG_FORMAT=gcp` line has no `trace_id` field; the exporter reads `logging.googleapis.com/trace` and `logging.googleapis.com/spanId` and still sets `trace_id` and `span_id` on the OTLP record. Unset `OTEL_LOGS_EXPORTER` does not open a logs exporter. AWS and GCP leave it unset. Local compose sets it.

Present when the log call or `withOrderId` set it: `orderId`. An explicit log field wins over the context value.

Present when the request context has a customer: `customer_hash`, a 16-character SHA-256 prefix. The raw customer id, name, and phone are not log fields. Shop sends the hash to other services on `x-customer-hash`.

Present when a fault matched or ran during the request: `fault.configured` and `fault.injected`.

### Access log

Each service writes one `request` line per call: `route` (the route template, such as `/orders/:orderId`, never the raw path), `method`, `status`, and `duration_ms`. Request and response bodies are not logged. `/health` is omitted.

### Side effects

`withSideEffectLog` wraps database writes, inventory reserve and release, payment charge and capture, delivery handoff, and each outbound HTTP call.

- Before the call, at debug: `about to <action>` with `action`.
- After a success, at info: `<action> succeeded` with `outcome=success` and `duration_ms`.
- Expected business failures (out of stock, declined payment) log a warning and rethrow.
- Timeouts, unexpected errors, and injected faults log an error, including `fault.injected` when a fault was thrown, and rethrow.

`action` is a stable name: `payment-charge`, `payment-capture`, `inventory-reserve`, `inventory-release`, `delivery-handoff`, `checkout`, or `db-write`. A database line's `operation` is the logical name (`order.write`, `transaction`), never SQL text. At `LOG_LEVEL=info` the debug line is hidden, so a normal leaf request stays near three lines: the access line, the business action, and one `db-write`.

Redaction happens in the logger:

- Known secret fields (`password`, `token`, `authorization`, `apiKey`, `accessToken`, and similar names) become `[REDACTED]`.
- Email addresses become `[REDACTED_EMAIL]`.
- Phone numbers written with a leading `+` or with separators become `[REDACTED_PHONE]`.
- `Bearer` tokens and `AKIA` access key ids in text become `[REDACTED]`.

`now()` is a monotonic millisecond clock for durations. It is not the log timestamp.

## HTTP metrics

`createHttpMetrics` records:

| Instrument                      | Meaning                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.server.request.duration`  | Latency histogram in milliseconds, keyed by `service`, `operation`, and method. Buckets run through 5s, 10s, 30s, and 60s so a database timeout past 5 seconds stays in a finite bucket and a p99 above 5 seconds can fire. Status code is not a histogram dimension, so one operation has one latency series. |
| `http.server.requests`          | Every response.                                                                                                                                                                                                                                                                                                |
| `http.server.errors`            | HTTP 5xx only.                                                                                                                                                                                                                                                                                                 |
| `http.server.business_outcomes` | Business results. HTTP 409 is `business_outcome=out_of_stock` and does not increment the error counter.                                                                                                                                                                                                        |

`operation` is the matched route template, for example `/cart/items/:id`. It is not the raw request URL: path parameters and query strings must not open new series. A request that matches no route is `unmatched`. `routeOperation` is the helper the services use.

`estimateHistogramPercentile` reads an explicit-bucket histogram and returns the inclusive upper bound of the bucket that crosses the percentile. A sample past the last boundary (60s) is reported as that boundary.

## Outbound metrics

`createOutboundMetrics` records `outbound.calls` for calls to another service and for calls to the service database. Attributes are `service`, `target` (`inventory`, `payment`, `delivery`, `shop`, or `database`), `outcome` (`success`, `error`, or `timeout`), and `operation`. `operation` is a logical name such as `reserve` or `order.write`. A raw URL is recorded as `unmatched`.

HTTP 409 from inventory is `outcome=success` on the outbound counter because the call completed. The server-side business counter still records `out_of_stock`, and `http.server.errors` still counts only 5xx.

## Fault injection

Faults are delay, error, drop, or timeout on a named operation (`reserve`, `charge`, `capture`, `handoff`, `checkout`, and the other route operations). The schedule is read once at startup. The kill switch is polled every 5–10 seconds (default 7.5s).

| Variable                        | Role                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_DEMO_FAULTS`              | JSON array. Each object has `id`, `type`, and optional `service`, `operation`, `probability`, and `delayMs`.                                                                                                                                                                                           |
| `OTEL_DEMO_FAULT_SCHEDULE`      | JSON object `{ windowStart, windowEnd, faults }`. Window timestamps are ISO-8601 UTC.                                                                                                                                                                                                                  |
| `OTEL_DEMO_FAULT_SCHEDULE_FILE` | Path to that object. Read once at startup.                                                                                                                                                                                                                                                             |
| `OTEL_DEMO_FAULT_WINDOW_START`  | Window start when the schedule is the `OTEL_DEMO_FAULTS` array.                                                                                                                                                                                                                                        |
| `OTEL_DEMO_FAULT_WINDOW_END`    | Window end. Faults stop at this instant. The process logs `fault window end` with `at` in UTC.                                                                                                                                                                                                         |
| `OTEL_DEMO_FAULTS_ENABLED`      | Env kill switch when `FAULT_SWITCH_SOURCE=env` (the default). `true`, `1`, or `on` enables the loaded schedule.                                                                                                                                                                                        |
| `FAULT_SWITCH_SOURCE`           | `env`, `file`, or `module`. `ssm` is rejected in application code.                                                                                                                                                                                                                                     |
| `FAULT_SWITCH_PROVIDER`         | Read by `@otel-demo/infra-gcp/fault-switch` when that module is the `FAULT_SWITCH_MODULE`. Default `aws-ssm` (the existing SSM reader). `gcp` reads Secret Manager, or `GCP_FAULT_SWITCH_SOURCE=config` reads `GCP_FAULT_SWITCH_VALUE` and makes no cloud call. `CLOUD_PROVIDER` does not change this. |
| `FAULT_SWITCH_FILE`             | File polled when the source is `file`. Contents are `on` or `off`.                                                                                                                                                                                                                                     |
| `FAULT_SWITCH_MODULE`           | Module specifier that exports `createFaultSwitch`. On AWS this is `/opt/fault-switch/fault-switch.cjs`. The package export `@otel-demo/infra-aws/fault-switch` is the same reader outside the image.                                                                                                   |
| `FAULT_SWITCH_SSM_PARAMETER`    | Parameter name. Falls back to `OTEL_DEMO_FAULTS_PARAMETER`, then `/otel-demo/faults-enabled`.                                                                                                                                                                                                          |
| `FAULT_SWITCH_POLL_MS`          | Poll interval, clamped to 5000–10000.                                                                                                                                                                                                                                                                  |

A successful read of `off` logs `faults off by operator` once for that transition. Faults fail closed: a read that errors or takes longer than `FAULT_SWITCH_READ_TIMEOUT_MS` (default 3s) turns faults off at once and logs `faults off by fail-safe`. The switch value is `off`, `on`/`all` (every configured fault), or a comma-separated list of fault ids from `OTEL_DEMO_FAULTS` (for example `payment-delay`), so one fault can be rehearsed alone without a deploy. The first poll inside an open window logs `fault window start` with `at` in UTC. Reaching `windowEnd` logs `fault window end` and stops injection without waiting for the kill switch.

`noteConfiguredFault` still records a match that was not performed (`fault.configured`, no `fault.injected`). `applyMatchedFault` performs the first matching fault whose probability roll succeeds (omitted probability is 1):

- `delay` sets `fault.injected` and waits `delayMs`. The span stays unset so a slow success is not an error.
- `error`, `timeout`, and `drop` set `fault.injected`, `fault.id`, `fault.type`, span status ERROR, and throw.

`loadFaultInjectionConfig` is unchanged: it still returns an empty list unless `OTEL_DEMO_FAULTS_ENABLED` is set, and it does not apply faults.

Each service calls `startServiceFaultControl` with its own name. When `OTEL_DEMO_LOAD_SCHEDULE_FILE` is set, that file replaces the single fault window: each spike's fault block becomes its own UTC window, the first spike of the experiment stays a baseline with no fault, and only windows for that service are armed. A missing or unreadable file fails startup. The single-window `OTEL_DEMO_FAULTS` list is not used while the load schedule is set. Startup logs `fault schedule loaded` with the service and its operations. The kill switch is still required and is polled. On AWS the task sets `FAULT_SWITCH_SOURCE=module` so the poll reads SSM (`OTEL_DEMO_FAULTS_PARAMETER`, default `/otel-demo/faults-enabled`) instead of a value captured once at process start. `LOADGEN_START_UTC` and `LOADGEN_SEED` override the file for both the generator and the services. `LOADGEN_CARTS_PER_MINUTE` is read only by the load generator. It scales cart activities to that many per minute and scales the other streams by the same factor, with a flat curve and even spacing (60 carts and at least one checkout in every hour when the rate is 1). Services do not read it, so fault windows stay on the file. Unset, the generator follows the file, which is the AWS and GCP path. A database `timeout` fault fails the SQL call before the driver and records `outcome=timeout`. `ping` is not faulted. Window start and end are logged in UTC. A process that starts inside a window does not log that start again. An injected fault sets `fault.injected` on the span and on the access log.

## Service ports

| Service   | Default port |
| --------- | ------------ |
| shop      | 3001         |
| inventory | 3002         |
| payment   | 3003         |
| delivery  | 3004         |

Override with `PORT`. Bind address is `HOST`, default `localhost`.
