import { describe, it, expect } from 'vitest';
import { cancelOrder, completeOrder, createOrder } from './order.js';
import type { Order } from './order.js';

const id = '3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b';
const description = 'Two boxes of widgets';

const orderWithStatus = (status: Order['status']): Order => ({
  id,
  description,
  status,
});

describe('createOrder', () => {
  it('creates an order with the provided id and description in Created status', () => {
    expect(createOrder(id, description)).toStrictEqual({
      id,
      description,
      status: 'Created',
    });
  });
});

describe('cancelOrder', () => {
  it('cancels a Created order, keeping its id and description', () => {
    expect(cancelOrder(orderWithStatus('Created'))).toStrictEqual({
      kind: 'OrderCancelled',
      order: { id, description, status: 'Cancelled' },
    });
  });

  it('rejects cancelling a Cancelled order', () => {
    expect(cancelOrder(orderWithStatus('Cancelled'))).toStrictEqual({
      kind: 'IllegalStatusTransition',
      from: 'Cancelled',
      to: 'Cancelled',
    });
  });

  it('rejects cancelling a Completed order', () => {
    expect(cancelOrder(orderWithStatus('Completed'))).toStrictEqual({
      kind: 'IllegalStatusTransition',
      from: 'Completed',
      to: 'Cancelled',
    });
  });

  it('does not modify the original order', () => {
    const order = orderWithStatus('Created');

    cancelOrder(order);

    expect(order).toStrictEqual(orderWithStatus('Created'));
  });
});

describe('completeOrder', () => {
  it('completes a Created order, keeping its id and description', () => {
    expect(completeOrder(orderWithStatus('Created'))).toStrictEqual({
      kind: 'OrderCompleted',
      order: { id, description, status: 'Completed' },
    });
  });

  it('rejects completing a Completed order', () => {
    expect(completeOrder(orderWithStatus('Completed'))).toStrictEqual({
      kind: 'IllegalStatusTransition',
      from: 'Completed',
      to: 'Completed',
    });
  });

  it('rejects completing a Cancelled order', () => {
    expect(completeOrder(orderWithStatus('Cancelled'))).toStrictEqual({
      kind: 'IllegalStatusTransition',
      from: 'Cancelled',
      to: 'Completed',
    });
  });

  it('does not modify the original order', () => {
    const order = orderWithStatus('Created');

    completeOrder(order);

    expect(order).toStrictEqual(orderWithStatus('Created'));
  });
});
