/**
 * Webhook body -> one JSON line per alert.
 * The function is self-contained: {@link receiverScript} ships its source to the container.
 */
export function formatAlertLines(body: unknown, nowIso: string): string[] {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }
  function toState(status: string): 'firing' | 'resolved' {
    const raw = status.toLowerCase();
    if (raw === 'resolved' || raw === 'ok' || raw === 'normal') {
      return 'resolved';
    }
    return 'firing';
  }

  const record = isRecord(body) ? body : {};
  const rawAlerts = Array.isArray(record.alerts) ? record.alerts : [];
  const alerts = rawAlerts.length > 0 ? rawAlerts : [record];
  const lines: string[] = [];
  for (const alert of alerts) {
    const item = isRecord(alert) ? alert : {};
    const labels = isRecord(item.labels) ? item.labels : {};
    const annotations = isRecord(item.annotations) ? item.annotations : {};
    const rule = text(labels.alertname) ?? text(item.alertname);
    if (!rule) {
      continue;
    }
    const status = text(item.status) ?? text(record.status) ?? '';
    const line = {
      event: 'grafana_alert_state_change',
      rule,
      severity: text(labels.severity) ?? 'unknown',
      previous: text(item.previousState) ?? text(record.previousState) ?? 'unknown',
      state: toState(status),
      time: nowIso,
      reason: text(annotations.reason) ?? text(annotations.summary) ?? '',
    };
    lines.push(JSON.stringify(line));
  }
  return lines;
}

/** Small HTTP receiver. Listens on localhost inside the Grafana task network namespace. */
export function receiverScript(): string {
  return `'use strict';
const http = require('http');
const formatAlertLines = ${formatAlertLines.toString()};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/alerts') {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = {};
    }
    const now = new Date().toISOString();
    for (const line of formatAlertLines(body, now)) {
      process.stdout.write(line + '\\n');
    }
    res.writeHead(204);
    res.end();
  });
});
server.listen(8088, 'localhost');
`;
}
