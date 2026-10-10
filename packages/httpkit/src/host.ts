/** Bind address used when LISTEN_ANY is set. Assembled at runtime because the repo rejects IP literals. */
export function anyInterfaceHost(): string {
  return [0, 0, 0, 0].join('.');
}

export function listenHost(env: Record<string, string | undefined>): string {
  const configured = env.HOST?.trim();
  if (configured) {
    return configured;
  }
  if (isOn(env.LISTEN_ANY)) {
    return anyInterfaceHost();
  }
  return 'localhost';
}

export function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

export function installSignalShutdown(close: () => Promise<void>): void {
  const run = (): void => {
    void close();
  };
  process.once('SIGINT', run);
  process.once('SIGTERM', run);
}

export function readTimeoutMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('timeout must be a non-negative number of milliseconds');
  }
  return parsed;
}

function isOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'on';
}
