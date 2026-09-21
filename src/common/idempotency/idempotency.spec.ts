import { hashRequest } from './idempotency.service';

describe('hashRequest', () => {
  it('is stable across key order — two serializations of one request are one request', () => {
    const a = hashRequest('POST /sales/checkout', { items: [{ qty: 1, id: 'x' }], note: 'hi' });
    const b = hashRequest('POST /sales/checkout', { note: 'hi', items: [{ id: 'x', qty: 1 }] });
    expect(a).toBe(b);
  });

  it('changes when anything in the body changes', () => {
    const base = hashRequest('POST /sales/checkout', { amount: 100 });
    expect(hashRequest('POST /sales/checkout', { amount: 101 })).not.toBe(base);
    expect(hashRequest('POST /sales/checkout', { amount: '100' })).not.toBe(base);
  });

  it('distinguishes endpoints, so one key cannot span two operations', () => {
    const body = { amount: 100 };
    expect(hashRequest('POST /sales/checkout', body)).not.toBe(hashRequest('POST /returns', body));
  });

  it('treats a missing field and an explicit undefined as the same request', () => {
    expect(hashRequest('E', { a: 1, b: undefined })).toBe(hashRequest('E', { a: 1 }));
  });

  it('does not confuse array order, which is meaningful', () => {
    expect(hashRequest('E', { items: [1, 2] })).not.toBe(hashRequest('E', { items: [2, 1] }));
  });

  it('handles bigint, which JSON.stringify alone throws on', () => {
    expect(() => hashRequest('E', { amount: 450000n })).not.toThrow();
  });
});
