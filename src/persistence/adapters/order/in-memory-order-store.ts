import type { Order } from '../../../domain/order/order.js';
import type { OrderStore } from '../../ports/order-store.js';

// In-memory only — state does not survive process restart.
export const createInMemoryOrderStore = (): OrderStore => {
  const orders = new Map<string, Order>();

  const save = (order: Order): void => {
    orders.set(order.id, order);
  };

  const findById = (id: string): Order | null => {
    return orders.get(id) ?? null;
  };

  const list = ({ limit, offset }: { limit: number; offset: number }): { items: Order[]; total: number } => {
    const all = Array.from(orders.values());
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
    };
  };

  return { save, findById, list };
};
