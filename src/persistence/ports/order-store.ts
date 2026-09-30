import type { Order } from '../../domain/order/order.js';
import type { PageRequest } from './page.js';

type OrderPage = {
  readonly items: readonly Order[];
  readonly total: number;
};

export type OrderStore = {
  readonly findById: (id: string) => Promise<Order | null>;
  readonly save: (order: Order) => Promise<void>;
  readonly list: (page: PageRequest) => Promise<OrderPage>;
};
