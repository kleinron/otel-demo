import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { currentCustomerHash, currentOrderId } from './context.js';
import { FaultInjectedError } from './fault-control.js';
import { outboundOperation } from './outbound.js';
import { now } from './time.js';

const depth = new AsyncLocalStorage<number>();

/** True while {@link withSideEffectLog} is running the side effect. */
export function insideSideEffect(): boolean {
  return (depth.getStore() ?? 0) > 0;
}

export interface SideEffectInput {
  /** Stable name such as `payment-charge` or `db-write`. */
  action: string;
  orderId?: string;
  customerHash?: string;
  /** Logical database or outbound operation. Never SQL text or a URL. */
  operation?: string;
  target?: string;
}

export interface SideEffectDetail {
  status?: number;
}

export type SideEffectVerdict = 'success' | { level: 'warn' | 'error'; outcome: string };

export interface SideEffectOptions<T> {
  /** Map a thrown error to a warn outcome. Anything else is an error. */
  expected?: (error: unknown) => string | undefined;
  /**
   * Classify a returned value. Expected business results warn; unexpected
   * results log at error. The value is still returned.
   */
  verdict?: (value: T) => SideEffectVerdict;
}

/**
 * Expected business failure (out of stock, declined payment). The wrapper logs
 * a warning and rethrows. Callers may translate that into an HTTP response
 * after the line is written.
 */
export class ExpectedSideEffectFailure extends Error {
  readonly outcome: string;
  readonly result?: unknown;

  constructor(outcome: string, result?: unknown) {
    super(outcome);
    this.name = 'ExpectedSideEffectFailure';
    this.outcome = outcome;
    this.result = result;
  }
}

/**
 * Log `about to <action>` at debug, then one closing line. Success is info.
 * Expected business failures are warnings. Timeouts, unexpected errors, and
 * injected faults are errors. The error is always rethrown.
 *
 * `LOG_LEVEL=info` (the default) hides the debug line. Set `LOG_LEVEL=debug`
 * on the process to see it. The level is not compiled into the image.
 */
export async function withSideEffectLog<T>(
  logger: Logger | undefined,
  fields: SideEffectInput,
  fn: (detail: SideEffectDetail) => Promise<T>,
  options: SideEffectOptions<T> = {},
): Promise<T> {
  if (!logger) {
    return fn({});
  }
  const parent = depth.getStore() ?? 0;
  return depth.run(parent + 1, () => record(logger, fields, fn, options));
}

async function record<T>(
  logger: Logger,
  fields: SideEffectInput,
  fn: (detail: SideEffectDetail) => Promise<T>,
  options: SideEffectOptions<T>,
): Promise<T> {
  const detail: SideEffectDetail = {};
  const started = now();
  logger.debug(lineFields(fields), `about to ${fields.action}`);
  try {
    const value = await fn(detail);
    const verdict = options.verdict?.(value) ?? 'success';
    if (verdict === 'success') {
      logger.info(closing(fields, detail, 'success', started), `${fields.action} succeeded`);
    } else if (verdict.level === 'warn') {
      logger.warn(
        closing(fields, detail, verdict.outcome, started),
        `${fields.action} ${verdict.outcome}`,
      );
    } else {
      logger.error(closing(fields, detail, verdict.outcome, started), `${fields.action} failed`);
    }
    return value;
  } catch (error) {
    const failure = classifyFailure(error, options.expected);
    const fieldsWithFault = {
      ...closing(fields, detail, failure.outcome, started),
      ...faultFields(error),
    };
    if (detail.status === undefined) {
      const status = statusOf(error);
      if (status !== undefined) {
        fieldsWithFault.status = status;
      }
    }
    if (failure.level === 'warn') {
      logger.warn(fieldsWithFault, `${fields.action} ${failure.outcome}`);
    } else {
      logger.error({ ...fieldsWithFault, ...errorFields(error) }, `${fields.action} failed`);
    }
    throw error;
  }
}

export function classifyFailure(
  error: unknown,
  expected?: (error: unknown) => string | undefined,
): { level: 'warn' | 'error'; outcome: string } {
  const expectedOutcome = expected?.(error);
  if (expectedOutcome) {
    return { level: 'warn', outcome: expectedOutcome };
  }
  if (error instanceof ExpectedSideEffectFailure) {
    return { level: 'warn', outcome: error.outcome };
  }
  if (isTimeoutError(error)) {
    return { level: 'error', outcome: 'timeout' };
  }
  return { level: 'error', outcome: 'error' };
}

function lineFields(fields: SideEffectInput): Record<string, unknown> {
  const line: Record<string, unknown> = { action: fields.action };
  const orderId = fields.orderId ?? currentOrderId();
  if (orderId) {
    line.orderId = orderId;
  }
  const hash = fields.customerHash ?? currentCustomerHash();
  if (hash) {
    line.customer_hash = hash;
  }
  if (fields.operation) {
    line.operation = outboundOperation(fields.operation);
  }
  if (fields.target) {
    line.target = fields.target;
  }
  return line;
}

function closing(
  fields: SideEffectInput,
  detail: SideEffectDetail,
  outcome: string,
  started: number,
): Record<string, unknown> {
  const line = lineFields(fields);
  line.outcome = outcome;
  line.duration_ms = elapsed(started);
  if (detail.status !== undefined) {
    line.status = detail.status;
  }
  return line;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(now() - started));
}

function faultFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof FaultInjectedError)) {
    return {};
  }
  return { 'fault.injected': true };
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof FaultInjectedError && error.faultType === 'timeout') {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === 'DbTimeoutError' || name === 'OutboundTimeoutError' || name === 'TimeoutError') {
    return true;
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return true;
  }
  return false;
}

const SAFE_MESSAGE =
  /connection terminated|terminating connection|connection (?:refused|reset)|server closed the connection|timeout exceeded when trying to connect|connection error|not queryable|socket hang up|database system is|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|transaction aborted/i;

/**
 * Error name, driver code and, when it is safe, the message for an unexpected
 * failure. A message is only logged when it carries a driver/system code or is
 * a known connection-level message, so SQL text and row values stay out of logs.
 */
export function errorFields(error: unknown): {
  error_name?: string;
  error_code?: string;
  error_message?: string;
} {
  const out: { error_name?: string; error_code?: string; error_message?: string } = {};
  const describe = (value: unknown): string | undefined => {
    if (!(value instanceof Error)) {
      return undefined;
    }
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' || SAFE_MESSAGE.test(value.message)
      ? value.message.slice(0, 200)
      : undefined;
  };
  if (error instanceof Error) {
    out.error_name = error.name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      out.error_code = code;
    }
    const message = describe(error);
    const cause = describe((error as { cause?: unknown }).cause);
    if (message || cause) {
      out.error_message = [message, cause && `cause: ${cause}`].filter(Boolean).join(' | ');
    }
  }
  return out;
}
