import { describe, expect, it } from 'vitest';
import { adotConfigYaml } from '../src/cdk/collector.js';
import { METRICS_LOG_GROUP } from '../src/names.js';

describe('ADOT collector config', () => {
  const yaml = adotConfigYaml();

  it('exports every trace and has no sampling processor', () => {
    expect(yaml).not.toContain('tail_sampling');
    expect(yaml).not.toContain('sampling_percentage');
    expect(yaml).not.toContain('probabilistic');
    expect(yaml).not.toContain('processors:');
    expect(yaml).toMatch(/traces:\n {6}receivers: \[otlp\]\n {6}exporters: \[awsxray\]/);
    expect(yaml).toContain('exporters: [awsxray]');
  });

  it('writes EMF metrics to the granted log group', () => {
    expect(yaml).toContain(`log_group_name: ${METRICS_LOG_GROUP}`);
    expect(METRICS_LOG_GROUP).toBe('/otel-demo/metrics');
  });
});
