type CustomerStatus = 'Active' | 'Inactive';

export type Customer = {
  id: string;
  name: string;
  status: CustomerStatus;
}

export type CreateCustomerInput = {
  id: string;
  name: string;
}

export const createCustomer = (input: CreateCustomerInput): Customer => {
  return { id: input.id, name: input.name, status: 'Active' };
};

export const deactivateCustomer = (customer: Customer): Customer => {
  return { id: customer.id, name: customer.name, status: 'Inactive' };
};
