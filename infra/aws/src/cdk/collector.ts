import { METRICS_LOG_GROUP } from '../names.js';

/**
 * ADOT sidecar config. OTLP in, CloudWatch metrics, X-Ray traces, CloudWatch Logs out.
 * Every span is exported. Each service runs its own collector, so a sampling
 * decision in one sidecar cannot keep a checkout trace whole across shop,
 * inventory, payment, and delivery.
 */
export function adotConfigYaml(): string {
  return `receivers:
  otlp:
    protocols:
      http:
        endpoint: localhost:4318
exporters:
  awsxray:
    region: eu-central-1
    indexed_attributes: ["operation", "fault.injected"]
  awsemf:
    region: eu-central-1
    namespace: otel-demo
    log_group_name: ${METRICS_LOG_GROUP}
    dimension_rollup_option: NoDimensionRollup
    metric_declarations:
      - dimensions: [[service, operation], [service]]
        metric_name_selectors: [".*"]
  awscloudwatchlogs:
    region: eu-central-1
    log_group_name: /otel-demo/adot
    log_stream_name: otlp
service:
  pipelines:
    # Every span. One collector per service cannot decide for the whole checkout.
    traces:
      receivers: [otlp]
      exporters: [awsxray]
    metrics:
      receivers: [otlp]
      exporters: [awsemf]
    logs:
      receivers: [otlp]
      exporters: [awscloudwatchlogs]
`;
}
