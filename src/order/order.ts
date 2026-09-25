export type OrderStatus = 'Created' | 'Cancelled' | 'Completed';

export type Order = {
  id: string;
  description: string;
  status: OrderStatus;
}

export type CreateOrderInput = {
  description: string;
}

export type OrderError = {
  kind: 'IllegalStatusTransition';
  from: OrderStatus;
  to: OrderStatus;
}

export type CreateOrderResult =
  | { kind: 'Success'; order: Order }
  | { kind: 'Error'; error: OrderError };

export type CancelOrderResult =
  | { kind: 'Success'; order: Order }
  | { kind: 'Error'; error: OrderError };

export type CompleteOrderResult =
  | { kind: 'Success'; order: Order }
  | { kind: 'Error'; error: OrderError };

export const createOrder = (
  input: CreateOrderInput,
  generateId: () => string
): CreateOrderResult => {
  return {
    kind: 'Success',
    order: { id: generateId(), description: input.description, status: 'Created' },
  };
};

export const cancelOrder = (order: Order): CancelOrderResult => {
  if (order.status !== 'Created') {
    return {
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: order.status, to: 'Cancelled' },
    };
  }

  return {
    kind: 'Success',
    order: { id: order.id, description: order.description, status: 'Cancelled' },
  };
};

export const completeOrder = (order: Order): CompleteOrderResult => {
  if (order.status !== 'Created') {
    return {
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: order.status, to: 'Completed' },
    };
  }

  return {
    kind: 'Success',
    order: { id: order.id, description: order.description, status: 'Completed' },
  };
};
