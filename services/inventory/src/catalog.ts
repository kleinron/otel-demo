export interface CatalogSku {
  sku: string;
  name: string;
  category: 'smartphones' | 'headphones' | 'power_banks' | 'laptops';
  priceCents: number;
}

export interface Warehouse {
  id: string;
  city: string;
}

export const CATALOG: readonly CatalogSku[] = [
  { sku: 'phone-aurora', name: 'Aurora Smartphone', category: 'smartphones', priceCents: 249900 },
  { sku: 'phone-carmel', name: 'Carmel Smartphone', category: 'smartphones', priceCents: 189900 },
  { sku: 'phone-negev', name: 'Negev Smartphone', category: 'smartphones', priceCents: 129900 },
  {
    sku: 'headphones-galilee',
    name: 'Galilee Headphones',
    category: 'headphones',
    priceCents: 49900,
  },
  {
    sku: 'headphones-sharon',
    name: 'Sharon Headphones',
    category: 'headphones',
    priceCents: 29900,
  },
  {
    sku: 'powerbank-dead-sea',
    name: 'Dead Sea Power Bank',
    category: 'power_banks',
    priceCents: 14900,
  },
  { sku: 'powerbank-carmel', name: 'Carmel Power Bank', category: 'power_banks', priceCents: 9900 },
  { sku: 'laptop-carmel-14', name: 'Carmel 14 Laptop', category: 'laptops', priceCents: 429900 },
  { sku: 'laptop-negev-16', name: 'Negev 16 Laptop', category: 'laptops', priceCents: 589900 },
];

export const WAREHOUSES: readonly Warehouse[] = [
  { id: 'wh-haifa', city: 'Haifa' },
  { id: 'wh-south', city: 'Beersheba' },
  { id: 'wh-tlv', city: 'Tel Aviv' },
];

/** Deterministic on-hand quantity. The Dead Sea power bank is scarce on purpose. */
export function stockOnHand(sku: string, warehouseId: string): number {
  if (sku === 'powerbank-dead-sea') {
    return warehouseId === 'wh-tlv' ? 1 : 0;
  }
  return 40;
}

export function skuById(sku: string): CatalogSku | undefined {
  return CATALOG.find((item) => item.sku === sku);
}
