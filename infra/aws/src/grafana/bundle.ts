import { gzipSync } from 'node:zlib';

const CHUNK = 3000;

/** Gzipped provisioning payload, split so each task-definition env value stays small. */
export function provisioningChunks(files: Record<string, string>): string[] {
  const packed = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  const chunks: string[] = [];
  for (let index = 0; index < packed.length; index += CHUNK) {
    chunks.push(packed.slice(index, index + CHUNK));
  }
  if (chunks.length > 20) {
    throw new Error('Grafana provisioning bundle is too large for the task definition');
  }
  return chunks;
}

export function provisioningWriterScript(): string {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const parts = [];
for (let i = 0; i < 20; i += 1) {
  const part = process.env['P' + i];
  if (!part) {
    break;
  }
  parts.push(part);
}
const files = JSON.parse(zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8'));
for (const [name, body] of Object.entries(files)) {
  if (typeof name !== 'string' || typeof body !== 'string' || name.includes('..') || path.isAbsolute(name)) {
    throw new Error('bad provisioning path');
  }
  const target = path.join('/provisioning', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, { mode: 0o644 });
}
`;
}
