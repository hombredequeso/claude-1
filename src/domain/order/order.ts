type OrderStatus = 'Created' | 'Cancelled' | 'Completed';

export type Order = {
  readonly id: string;
  readonly description: string;
  readonly status: OrderStatus;
};

export type IllegalStatusTransition = {
  kind: 'IllegalStatusTransition';
  from: OrderStatus;
  to: OrderStatus;
};

type OrderCancelled = {
  kind: 'OrderCancelled';
  order: Order;
};

type OrderCompleted = {
  kind: 'OrderCompleted';
  order: Order;
};

export type CancelOrderResult = OrderCancelled | IllegalStatusTransition;

export type CompleteOrderResult = OrderCompleted | IllegalStatusTransition;

export const createOrder = (id: string, description: string): Order => ({
  id,
  description,
  status: 'Created',
});

const withStatus = (order: Order, status: OrderStatus): Order => ({
  id: order.id,
  description: order.description,
  status,
});

export const cancelOrder = (order: Order): CancelOrderResult => {
  switch (order.status) {
    case 'Created':
      return { kind: 'OrderCancelled', order: withStatus(order, 'Cancelled') };
    case 'Cancelled':
    case 'Completed':
      return { kind: 'IllegalStatusTransition', from: order.status, to: 'Cancelled' };
    default:
      throw order.status satisfies never;
  }
};

export const completeOrder = (order: Order): CompleteOrderResult => {
  switch (order.status) {
    case 'Created':
      return { kind: 'OrderCompleted', order: withStatus(order, 'Completed') };
    case 'Cancelled':
    case 'Completed':
      return { kind: 'IllegalStatusTransition', from: order.status, to: 'Completed' };
    default:
      throw order.status satisfies never;
  }
};
