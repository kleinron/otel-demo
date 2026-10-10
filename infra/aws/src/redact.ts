const ARN =
  /\barn:(?:aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s'"\\]*/gi;
const AWS_HOSTNAME =
  /\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.(?:rds|elb|es|cache)\.amazonaws\.com\b/gi;
const INTERNAL_HOSTNAME = /\b[a-z0-9](?:[a-z0-9.-]{0,200})?\.compute\.internal\b/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const ACCOUNT_ID = /\b\d{12}\b/g;

/** Strip account ids, ARNs, IP addresses, and cloud hostnames before anything is written. */
export function redactText(value: string): string {
  return value
    .replace(AWS_HOSTNAME, '[redacted-hostname]')
    .replace(INTERNAL_HOSTNAME, '[redacted-hostname]')
    .replace(ARN, '[redacted-arn]')
    .replace(IPV4, '[redacted-ip]')
    .replace(ACCOUNT_ID, '[redacted-account]');
}

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return redactText(String(error));
}
