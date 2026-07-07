/**
 * 版本化 JSON 信封（沿用 AIDCP 信封思想，但泛型化到各服务自定义的 TType）。
 * 内部同进程 apps 之间用不到 WS 信封；此结构供未来跨进程/回放/审计统一封装。
 */
export const PROTOCOL_VERSION = 1;

export interface Envelope<TType extends string, TPayload = unknown> {
  v: number;
  type: TType;
  id: string;
  ts: number;
  payload: TPayload;
}

export function makeEnvelope<TType extends string, TPayload>(
  type: TType,
  id: string,
  ts: number,
  payload: TPayload,
): Envelope<TType, TPayload> {
  return { v: PROTOCOL_VERSION, type, id, ts, payload };
}

export function isEnvelope(x: unknown): x is Envelope<string> {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.type === 'string' &&
    typeof e.id === 'string' &&
    typeof e.ts === 'number' &&
    'payload' in e
  );
}
