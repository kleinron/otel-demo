export type CloudProvider = 'aws' | 'gcp';

export type LogFormat = 'default' | 'gcp';

/** Cloud Logging field that links a line to a trace in Log Explorer. */
export const GCP_TRACE_FIELD = 'logging.googleapis.com/trace';

/** Cloud Logging field for the span id (16 lowercase hex characters). */
export const GCP_SPAN_ID_FIELD = 'logging.googleapis.com/spanId';

/** Cloud Logging sampled bit. The view-trace link uses it with the trace field. */
export const GCP_TRACE_SAMPLED_FIELD = 'logging.googleapis.com/trace_sampled';

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * `CLOUD_PROVIDER=aws|gcp`. Unset and empty match `aws`, which is the
 * default path the AWS tasks already run.
 */
export function resolveCloudProvider(env: Record<string, string | undefined>): CloudProvider {
  const raw = (env.CLOUD_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'aws') {
    return 'aws';
  }
  if (raw === 'gcp') {
    return 'gcp';
  }
  throw new Error(`Unknown CLOUD_PROVIDER ${raw}`);
}

/**
 * `LOG_FORMAT=gcp` renames log fields for Cloud Logging. Unset and `default`
 * keep the existing JSON shape.
 */
export function resolveLogFormat(env: Record<string, string | undefined>): LogFormat {
  const raw = (env.LOG_FORMAT ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'default') {
    return 'default';
  }
  if (raw === 'gcp') {
    return 'gcp';
  }
  throw new Error(`Unknown LOG_FORMAT ${raw}`);
}

/** Project id used in `logging.googleapis.com/trace`. Empty when unset or invalid. */
export function resolveGcpProjectId(env: Record<string, string | undefined>): string | undefined {
  const value = env.GCP_PROJECT_ID?.trim() ?? '';
  if (!PROJECT_ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

/** `projects/<project>/traces/<trace id>` for the Cloud Logging trace field. */
export function gcpTraceField(projectId: string, traceId: string): string {
  return `projects/${projectId}/traces/${traceId}`;
}
