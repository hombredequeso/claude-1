import type { Order } from '../../../domain/order/order.js';
import type { OrderStore } from '../../ports/order-store.js';

// Orders are listed in the order they were first saved (Map preserves
// insertion order, and re-saving an existing key keeps its position).
// Listing walks the Map's iterator lazily, so a page costs offset + limit
// steps rather than a copy of every order.
export const createInMemoryOrderStore = (): OrderStore => {
  const orders = new Map<string, Order>();

  return {
    findById: async (id) => orders.get(id) ?? null,
    save: async (order) => {
      orders.set(order.id, order);
    },
    list: async ({ limit, offset }) => ({
      items: orders.values().drop(offset).take(limit).toArray(),
      // memory intensive version (use for testing):
      // items: Array.from(orders.values()).slice(offset, offset + limit),
      total: orders.size,
    }),
  };
};
