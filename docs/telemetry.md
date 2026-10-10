# Telemetry

`packages/telemetry` is provider-neutral. It configures the OpenTelemetry Node SDK with OTLP over HTTP (`http/protobuf`), propagates W3C `traceparent`, and does not import a cloud SDK or a vendor exporter (no X-Ray, Zipkin, Jaeger, Prometheus, or OTLP/gRPC).

Host resource detection is off. A machine address is not attached automatically. Set resource attributes explicitly.

## Export

| Variable                              | Role                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base URL. Signal paths `/v1/traces` and `/v1/metrics` are appended. Default `http://localhost:4318`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Full traces URL. Overrides the base.                                                                 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL. Overrides the base.                                                                |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Shared `key=value` list. Signal-specific header variables override the same key.                     |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`   | Extra traces headers.                                                                                |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS`  | Extra metrics headers.                                                                               |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | Must be unset or `http/protobuf`.                                                                    |
| `OTEL_SDK_DISABLED`                   | `true` skips SDK startup.                                                                            |

## Resource

| Variable                   | Attribute                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `OTEL_SERVICE_NAME`        | `service.name`. Overrides the name passed by the service.                                |
| `OTEL_SERVICE_VERSION`     | `service.version`.                                                                       |
| `DEPLOYMENT_ENVIRONMENT`   | `deployment.environment.name`, unless that key is already in `OTEL_RESOURCE_ATTRIBUTES`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra `key=value` resource attributes.                                                   |

`service.name` is required, from the service call or from `OTEL_SERVICE_NAME`.

## Logs

`createLogger({ service })` writes one JSON object per line through pino. The level defaults to `info`. The demo tasks set `LOG_LEVEL=info` and `OTEL_LOG_LEVEL=error` so the lines that reach CloudWatch stay small.

Present on every line: `service`, `level`, `msg`, `time`.

Present when a valid span is active: `trace_id`, `span_id`, and `xray_trace_id`. The X-Ray field is the encoding `1-{first 8 hex}-{last 24 hex}` of the W3C trace id. Export is still OTLP. `startTelemetry` installs the async context manager those fields are read from.

Present when the log call or `withOrderId` set it: `orderId`. An explicit log field wins over the context value.

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

## Fault injection

Off by default. Nothing is delayed, failed, or dropped in this phase.

| Variable                   | Role                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_DEMO_FAULTS_ENABLED` | Must be `true`, `1`, or `on`. Anything else, including unset, leaves injection off and ignores the fault list.                                                       |
| `OTEL_DEMO_FAULTS`         | JSON array, read only when injection is enabled. Each object has `id`, `type` (`delay`, `error`, or `drop`), and optional `service`, `operation`, and `probability`. |

`noteConfiguredFault` records every matching fault on the current span as configured, not applied:

- `fault.configured` = `true` when a fault rule matched and was not performed
- `fault.id` = every matching id
- `fault.type` = every matching type
- `fault.injected` stays unset

`fault.injected` is reserved for a fault that was actually applied (the delay, error, or drop ran). This phase never applies a fault, so it never sets `fault.injected`. `probability` is stored and not rolled.

## Service ports

| Service   | Default port |
| --------- | ------------ |
| shop      | 3001         |
| inventory | 3002         |
| payment   | 3003         |
| delivery  | 3004         |

Override with `PORT`. Bind address is `HOST`, default `localhost`.
