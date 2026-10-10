import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import {
  FAULT_CONFIGURED_ATTRIBUTE,
  FAULT_ID_ATTRIBUTE,
  FAULT_INJECTED_ATTRIBUTE,
  FAULT_TYPE_ATTRIBUTE,
  loadFaultInjectionConfig,
  noteConfiguredFault,
} from '../src/index.js';

const FAULTS = JSON.stringify([
  {
    id: 'inventory-delay',
    service: 'inventory',
    operation: 'reserve',
    type: 'delay',
    probability: 1,
  },
  { id: 'inventory-error', service: 'inventory', operation: 'reserve', type: 'error' },
  { id: 'payment-drop', service: 'payment', operation: 'charge', type: 'drop' },
]);

describe('fault injection skeleton', () => {
  it('is off by default and ignores the fault list', () => {
    expect(loadFaultInjectionConfig({}).enabled).toBe(false);
    expect(loadFaultInjectionConfig({ OTEL_DEMO_FAULTS: FAULTS })).toEqual({
      enabled: false,
      faults: [],
    });
    expect(loadFaultInjectionConfig({ OTEL_DEMO_FAULTS: 'not-json' }).faults).toEqual([]);
  });

  it('parses faults only when explicitly enabled', () => {
    const config = loadFaultInjectionConfig({
      OTEL_DEMO_FAULTS_ENABLED: 'true',
      OTEL_DEMO_FAULTS: FAULTS,
    });

    expect(config.enabled).toBe(true);
    expect(config.faults.map((fault) => fault.id)).toEqual([
      'inventory-delay',
      'inventory-error',
      'payment-drop',
    ]);
  });

  it('rejects an invalid fault list when injection is enabled', () => {
    expect(() =>
      loadFaultInjectionConfig({
        OTEL_DEMO_FAULTS_ENABLED: 'on',
        OTEL_DEMO_FAULTS: '{"id":"x"}',
      }),
    ).toThrow(/JSON array/);
  });

  it('records a match as configured and leaves fault.injected unset', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer('inventory').startSpan('reserve');
    const config = loadFaultInjectionConfig({
      OTEL_DEMO_FAULTS_ENABLED: 'true',
      OTEL_DEMO_FAULTS: FAULTS,
    });

    const matched = noteConfiguredFault(
      config,
      { service: 'inventory', operation: 'reserve' },
      span,
    );
    span.end();

    expect(matched.map((fault) => fault.id)).toEqual(['inventory-delay', 'inventory-error']);
    const finished = exporter.getFinishedSpans()[0];
    expect(finished?.attributes[FAULT_CONFIGURED_ATTRIBUTE]).toBe(true);
    expect(finished?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
    expect(finished?.attributes[FAULT_ID_ATTRIBUTE]).toEqual([
      'inventory-delay',
      'inventory-error',
    ]);
    expect(finished?.attributes[FAULT_TYPE_ATTRIBUTE]).toEqual(['delay', 'error']);
    expect(finished?.status.code).toBe(0);
  });

  it('records nothing when injection is off or no fault matches', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const disabled = provider.getTracer('inventory').startSpan('reserve');
    noteConfiguredFault(
      loadFaultInjectionConfig({ OTEL_DEMO_FAULTS: FAULTS }),
      { service: 'inventory', operation: 'reserve' },
      disabled,
    );
    disabled.end();

    const unmatched = provider.getTracer('delivery').startSpan('handoff');
    noteConfiguredFault(
      loadFaultInjectionConfig({ OTEL_DEMO_FAULTS_ENABLED: 'true', OTEL_DEMO_FAULTS: FAULTS }),
      { service: 'delivery', operation: 'handoff' },
      unmatched,
    );
    unmatched.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes[FAULT_CONFIGURED_ATTRIBUTE]).toBeUndefined();
    expect(spans[0]?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
    expect(spans[1]?.attributes[FAULT_CONFIGURED_ATTRIBUTE]).toBeUndefined();
    expect(spans[1]?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
  });
});
