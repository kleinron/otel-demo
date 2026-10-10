import { asInt, isUniqueViolation, type Sql } from '@otel-demo/db';

export const ORDER_STATUSES = [
  'cart',
  'reserved',
  'paid',
  'handed_to_delivery',
  'out_of_stock',
  'payment_declined',
  'payment_unknown',
  'delivery_pending',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface CartItem {
  sku: string;
  qty: number;
  unitPriceCents: number;
}

export interface Cart {
  cartId: string;
  customerId: string;
  items: CartItem[];
}

export interface Order {
  orderId: string;
  cartId: string;
  customerId: string;
  status: OrderStatus;
  city: string;
  amountCents: number;
}

export interface Customer {
  id: string;
  city: string;
}

interface ItemRow extends Record<string, unknown> {
  sku: string;
  qty: number | string;
  unit_price_cents: number | string;
}

interface OrderRow extends Record<string, unknown> {
  id: string;
  cart_id: string;
  customer_id: string;
  status: string;
  city: string;
  amount_cents: number | string;
}

export interface ShopRepo {
  customer(id: string): Promise<Customer | undefined>;
  createCart(customerId: string): Promise<Cart>;
  getCart(cartId: string): Promise<Cart | undefined>;
  addItem(cartId: string, item: CartItem): Promise<Cart | undefined>;
  removeItem(cartId: string, sku: string): Promise<Cart | undefined>;
  findOrder(orderId: string): Promise<Order | undefined>;
  findOrderByCart(cartId: string): Promise<Order | undefined>;
  createOrder(input: {
    orderId: string;
    cartId: string;
    customerId: string;
    city: string;
    amountCents: number;
  }): Promise<Order>;
  updateStatus(orderId: string, status: OrderStatus): Promise<Order>;
}

export function createShopRepo(sql: Sql): ShopRepo {
  return {
    async customer(id) {
      const result = await sql.query<{ id: string; city: string }>(
        'SELECT id, city FROM customers WHERE id = $1',
        [id],
        'customer.read',
      );
      return result.rows[0];
    },

    async createCart(customerId) {
      const cartId = crypto.randomUUID();
      await sql.query(
        'INSERT INTO carts (id, customer_id, created_at) VALUES ($1, $2, $3)',
        [cartId, customerId, new Date().toISOString()],
        'cart.write',
      );
      return { cartId, customerId, items: [] };
    },

    async getCart(cartId) {
      return readCart(sql, cartId);
    },

    async addItem(cartId, item) {
      const cart = await readCart(sql, cartId);
      if (!cart) {
        return undefined;
      }
      await sql.query(
        `INSERT INTO cart_items (cart_id, sku, qty, unit_price_cents) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cart_id, sku) DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty`,
        [cartId, item.sku, item.qty, item.unitPriceCents],
        'cart.write',
      );
      return readCart(sql, cartId);
    },

    async removeItem(cartId, sku) {
      const cart = await readCart(sql, cartId);
      if (!cart) {
        return undefined;
      }
      await sql.query(
        'DELETE FROM cart_items WHERE cart_id = $1 AND sku = $2',
        [cartId, sku],
        'cart.write',
      );
      return readCart(sql, cartId);
    },

    async findOrder(orderId) {
      const result = await sql.query<OrderRow>(
        'SELECT id, cart_id, customer_id, status, city, amount_cents FROM orders WHERE id = $1',
        [orderId],
        'order.read',
      );
      const row = result.rows[0];
      return row ? mapOrder(row) : undefined;
    },

    async findOrderByCart(cartId) {
      const result = await sql.query<OrderRow>(
        'SELECT id, cart_id, customer_id, status, city, amount_cents FROM orders WHERE cart_id = $1',
        [cartId],
        'order.read',
      );
      const row = result.rows[0];
      return row ? mapOrder(row) : undefined;
    },

    async createOrder(input) {
      const now = new Date().toISOString();
      try {
        await sql.query(
          `INSERT INTO orders (id, cart_id, customer_id, status, city, amount_cents, created_at, updated_at)
           VALUES ($1, $2, $3, 'cart', $4, $5, $6, $7)`,
          [input.orderId, input.cartId, input.customerId, input.city, input.amountCents, now, now],
          'order.write',
        );
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      const stored = await this.findOrder(input.orderId);
      if (!stored) {
        throw new Error(`order ${input.orderId} was not stored`);
      }
      return stored;
    },

    async updateStatus(orderId, status) {
      const result = await sql.query<OrderRow>(
        `UPDATE orders SET status = $2, updated_at = $3 WHERE id = $1
         RETURNING id, cart_id, customer_id, status, city, amount_cents`,
        [orderId, status, new Date().toISOString()],
        'order.write',
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`order ${orderId} was not found`);
      }
      return mapOrder(row);
    },
  };
}

async function readCart(sql: Sql, cartId: string): Promise<Cart | undefined> {
  const cart = await sql.query<{ id: string; customer_id: string }>(
    'SELECT id, customer_id FROM carts WHERE id = $1',
    [cartId],
    'cart.read',
  );
  const header = cart.rows[0];
  if (!header) {
    return undefined;
  }
  const items = await sql.query<ItemRow>(
    'SELECT sku, qty, unit_price_cents FROM cart_items WHERE cart_id = $1 ORDER BY sku',
    [cartId],
    'cart.read',
  );
  return {
    cartId: header.id,
    customerId: header.customer_id,
    items: items.rows.map((row) => ({
      sku: row.sku,
      qty: asInt(row.qty),
      unitPriceCents: asInt(row.unit_price_cents),
    })),
  };
}

function mapOrder(row: OrderRow): Order {
  if (!isOrderStatus(row.status)) {
    throw new Error(`unknown order status ${row.status}`);
  }
  return {
    orderId: row.id,
    cartId: row.cart_id,
    customerId: row.customer_id,
    status: row.status,
    city: row.city,
    amountCents: asInt(row.amount_cents),
  };
}

function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}
