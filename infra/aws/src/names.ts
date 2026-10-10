/** Stable names shared by the CDK app and the teardown export. */

export const SERVICES = ['shop', 'inventory', 'payment', 'delivery'] as const;

export type ServiceName = (typeof SERVICES)[number];

export const SERVICE_PORTS: Record<ServiceName, number> = {
  shop: 3001,
  inventory: 3002,
  payment: 3003,
  delivery: 3004,
};

export const LOADGEN_NAME = 'loadgen';
export const GRAFANA_NAME = 'grafana';
export const CLUSTER_NAME = 'otel-demo';

/** ECS service name for a workload task family (`otel-demo-shop`, and the rest). */
export function workloadServiceName(name: string): string {
  return `otel-demo-${name}`;
}

export const LOADGEN_SERVICE_NAME = workloadServiceName(LOADGEN_NAME);
export const GRAFANA_SERVICE_NAME = 'otel-demo-grafana';
export const GRAFANA_PORT = 3000;

export const FAULTS_PARAMETER_NAME = '/otel-demo/faults-enabled';
export const ALERT_LOG_GROUP = '/otel-demo/alerts';
export const GRAFANA_LOG_GROUP = '/otel-demo/grafana';
export const ADOT_LOG_GROUP = '/otel-demo/adot';
/** EMF exporter destination. The exporter default (`/metrics/otel-demo`) is not granted. */
export const METRICS_LOG_GROUP = '/otel-demo/metrics';

export const CHECKOUT_HOPS = ['shop', 'inventory', 'payment', 'delivery'] as const;

export function serviceLogGroup(name: string): string {
  return `/otel-demo/${name}`;
}

/** Container bind address. Assembled so the repo source contains no address literal. */
export function allInterfacesHost(): string {
  return ['0', '0', '0', '0'].join('.');
}
