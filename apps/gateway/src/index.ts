/**
 * @aiim/gateway — 微信协议网关（执行端）。调服务商 API + 归一化回调 + 如实回报，不做决策。
 */
export { createGateway } from './gateway';
export type { GatewayHandle, GatewayPacing } from './gateway';
export { FakeProvider } from './provider';
export type { Provider, ProviderClient, ProviderInbound, ProviderCallback, ProviderAddResult, ProviderAgreeResult, FakeProviderOptions } from './provider';
