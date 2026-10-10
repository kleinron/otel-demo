import type { SdkClient, SdkCommand } from './types.js';
import { asRecord, tokenOf } from './text.js';

export async function collectPages(
  client: SdkClient,
  make: (token: string | undefined) => SdkCommand,
  read: (page: Record<string, unknown>) => { items: unknown[]; token?: string },
): Promise<unknown[]> {
  const items: unknown[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = asRecord(await client.send(make(token)));
    const next = read(page);
    items.push(...next.items);
    const nextToken = tokenOf(next.token);
    if (!nextToken) {
      return items;
    }
    if (seen.has(nextToken)) {
      throw new Error('pagination token repeated');
    }
    seen.add(nextToken);
    token = nextToken;
  }
}
