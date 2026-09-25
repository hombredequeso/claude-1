import type { Order } from '../../domain/order/order.js';

export type OrderStore = {
  save: (order: Order) => void;
  findById: (id: string) => Order | null;
  list: (params: { limit: number; offset: number }) => { items: Order[]; total: number };
}
