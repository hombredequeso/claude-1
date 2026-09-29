import { describe, it, expect } from 'vitest';
import { createCustomer, deactivateCustomer, type Customer } from './customer.js';

const id = '22222222-2222-2222-2222-222222222222';
const name = 'Ada Lovelace';

describe('createCustomer', () => {
  it('creates an Active customer with the provided id and name', () => {
    const result = createCustomer({ id, name });

    expect(result).toStrictEqual({ id, name, status: 'Active' });
  });
});

describe('deactivateCustomer', () => {
  it('deactivates an Active customer', () => {
    const customer: Customer = { id, name, status: 'Active' };

    const result = deactivateCustomer(customer);

    expect(result).toStrictEqual({ id, name, status: 'Inactive' });
  });

  it('leaves an already Inactive customer Inactive', () => {
    const customer: Customer = { id, name, status: 'Inactive' };

    const result = deactivateCustomer(customer);

    expect(result).toStrictEqual({ id, name, status: 'Inactive' });
  });
});
