/**
 * ADOT sidecar config. OTLP in, CloudWatch metrics, X-Ray traces, CloudWatch Logs out.
 * Tail sampling keeps checkout, payment, and delivery, plus errors, slow traces, and
 * fault-tagged traces. Browse and cart are sampled.
 */
export function adotConfigYaml(): string {
  return `receivers:
  otlp:
    protocols:
      http:
        endpoint: localhost:4318
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 2000
    expected_new_traces_per_sec: 20
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow
        type: latency
        latency:
          threshold_ms: 2000
      - name: fault-injected
        type: string_attribute
        string_attribute:
          key: fault.injected
          values: ["true"]
      - name: payment-and-delivery-services
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["payment", "delivery"]
      - name: checkout-payment-delivery-operations
        type: string_attribute
        string_attribute:
          key: operation
          values: ["checkout", "payment", "delivery"]
      - name: browse-and-cart-sample
        type: and
        and:
          and_sub_policy:
            - name: browse-or-cart
              type: string_attribute
              string_attribute:
                key: operation
                values: ["browse", "cart", "add-to-cart", "remove-from-cart"]
            - name: ten-percent
              type: probabilistic
              probabilistic:
                sampling_percentage: 10
exporters:
  awsxray:
    region: eu-central-1
    indexed_attributes: ["operation", "fault.injected"]
  awsemf:
    region: eu-central-1
    namespace: otel-demo
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
    traces:
      receivers: [otlp]
      processors: [tail_sampling]
      exporters: [awsxray]
    metrics:
      receivers: [otlp]
      exporters: [awsemf]
    logs:
      receivers: [otlp]
      exporters: [awscloudwatchlogs]
`;
}
