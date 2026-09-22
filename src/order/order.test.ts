import { describe, it, expect } from 'vitest';
import { createOrder, cancelOrder, completeOrder, type Order } from './order.js';

const id = '11111111-1111-1111-1111-111111111111';
const description = 'A widget';

describe('createOrder', () => {
  it('creates an order with status Created, using the generated id', () => {
    const result = createOrder({ description }, () => id);

    expect(result).toStrictEqual({
      kind: 'Success',
      order: { id, description, status: 'Created' },
    });
  });
});

describe('completeOrder', () => {
  it('completes a Created order', () => {
    const order: Order = { id, description, status: 'Created' };

    const result = completeOrder(order);

    expect(result).toStrictEqual({
      kind: 'Success',
      order: { id, description, status: 'Completed' },
    });
  });

  it('rejects completing a Cancelled order', () => {
    const order: Order = { id, description, status: 'Cancelled' };

    const result = completeOrder(order);

    expect(result).toStrictEqual({
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: 'Cancelled', to: 'Completed' },
    });
  });

  it('rejects completing an already Completed order', () => {
    const order: Order = { id, description, status: 'Completed' };

    const result = completeOrder(order);

    expect(result).toStrictEqual({
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: 'Completed', to: 'Completed' },
    });
  });
});

describe('cancelOrder', () => {
  it('cancels a Created order', () => {
    const order: Order = { id, description, status: 'Created' };

    const result = cancelOrder(order);

    expect(result).toStrictEqual({
      kind: 'Success',
      order: { id, description, status: 'Cancelled' },
    });
  });

  it('rejects cancelling a Completed order', () => {
    const order: Order = { id, description, status: 'Completed' };

    const result = cancelOrder(order);

    expect(result).toStrictEqual({
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: 'Completed', to: 'Cancelled' },
    });
  });

  it('rejects cancelling an already Cancelled order', () => {
    const order: Order = { id, description, status: 'Cancelled' };

    const result = cancelOrder(order);

    expect(result).toStrictEqual({
      kind: 'Error',
      error: { kind: 'IllegalStatusTransition', from: 'Cancelled', to: 'Cancelled' },
    });
  });
});
