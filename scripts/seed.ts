import { connectPg } from '@otel-demo/db';
import { dropDelivery, migrateDelivery } from '../services/delivery/src/schema.js';
import { seedInventory } from '../services/inventory/src/seed.js';
import { dropPayment, migratePayment } from '../services/payment/src/schema.js';
import { seedShop } from '../services/shop/src/seed.js';

const shopUrl = required('SHOP_DATABASE_URL');
const inventoryUrl = required('INVENTORY_DATABASE_URL');
const paymentUrl = required('PAYMENT_DATABASE_URL');
const deliveryUrl = required('DELIVERY_DATABASE_URL');

const shop = await connectPg(shopUrl);
const inventory = await connectPg(inventoryUrl);
const payment = await connectPg(paymentUrl);
const delivery = await connectPg(deliveryUrl);

try {
  await seedShop(shop);
  await seedInventory(inventory);
  await dropPayment(payment);
  await migratePayment(payment);
  await dropDelivery(delivery);
  await migrateDelivery(delivery);
} finally {
  await shop.close();
  await inventory.close();
  await payment.close();
  await delivery.close();
}

process.stdout.write('seeded shop, inventory, payment, and delivery\n');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
