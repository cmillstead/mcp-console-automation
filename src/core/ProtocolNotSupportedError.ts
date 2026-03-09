export class ProtocolNotSupportedError extends Error {
  public readonly method: string;
  public readonly protocolType: string;

  constructor(method: string, protocolType: string) {
    super(`${method} is not supported by ${protocolType} protocol`);
    this.name = 'ProtocolNotSupportedError';
    this.method = method;
    this.protocolType = protocolType;
  }
}
