import { ProtocolFactory } from '../../src/core/ProtocolFactory.js';

describe('ProtocolFactory.resetInstance', () => {
  afterEach(() => {
    ProtocolFactory.resetInstance();
  });

  it('should return the same instance on consecutive calls', () => {
    const a = ProtocolFactory.getInstance();
    const b = ProtocolFactory.getInstance();
    expect(a).toBe(b);
  });

  it('should return a new instance after reset', () => {
    const first = ProtocolFactory.getInstance();
    ProtocolFactory.resetInstance();
    const second = ProtocolFactory.getInstance();

    expect(second).toBeInstanceOf(ProtocolFactory);
    expect(second).not.toBe(first);
  });
});
