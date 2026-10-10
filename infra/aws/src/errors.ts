export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & { Code?: string };
    return [error.name, extra.Code, error.message].filter(Boolean).join(' ');
  }
  if (error !== null && typeof error === 'object') {
    const record = error as {
      name?: unknown;
      Code?: unknown;
      message?: unknown;
      Message?: unknown;
    };
    return [record.name, record.Code, record.message, record.Message]
      .filter((part) => typeof part === 'string')
      .join(' ');
  }
  return String(error);
}

/** True when a delete is a no-op because the resource is already absent. */
export function isAlreadyGone(error: unknown): boolean {
  const text = errorText(error);
  return /NotFound|NoSuch|does not exist|RepositoryNotFound|DBSnapshotNotFound|LoadBalancerNotFound|ClusterNotFound|InvalidNetworkInterfaceID\.NotFound/i.test(
    text,
  );
}
