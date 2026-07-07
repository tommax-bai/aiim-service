/**
 * 内存事件总线 — typed EventEmitter（领域无关，从 aidcp-cloud 复制并**泛型化**）。
 * AIDCP 的 EventBus 类本身零 XHS，却 `import` 死了 XHS 的 AllEventMap；这里改成 `EventBus<TMap>`，
 * 事件 map 由各域（微信域见 @aiim/contracts 的 WechatEventMap）注入，机制不再认识任何具体事件。
 * fire-and-forget 语义，handler 异常不阻塞其他订阅者。
 */

type Handler<T> = (data: T) => void | Promise<void>;
type WildcardHandler = (event: string, data: unknown) => void;

export class EventBus<TMap extends Record<string, unknown>> {
  private handlers = new Map<string, Set<Handler<unknown>>>();
  private wildcardHandlers = new Set<WildcardHandler>();

  /** 订阅事件，返回取消订阅函数。 */
  on<K extends keyof TMap & string>(event: K, handler: Handler<TMap[K]>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event)!;
    set.add(handler as Handler<unknown>);
    return () => { set.delete(handler as Handler<unknown>); };
  }

  /** 一次性订阅，触发后自动取消。 */
  once<K extends keyof TMap & string>(event: K, handler: Handler<TMap[K]>): () => void {
    const wrapper: Handler<TMap[K]> = (data) => {
      unsub();
      return handler(data);
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  /** 手动取消订阅。 */
  off<K extends keyof TMap & string>(event: K, handler: Handler<TMap[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  /** 同步触发（fire-and-forget）。handler 的 Promise 被忽略，抛错不影响其他 handler。 */
  emit<K extends keyof TMap & string>(event: K, data: TMap[K]): void {
    this.dispatch(event, data);
  }

  /** 类型擦除的转发用 emit：跨总线转发/聚合（每连接私有通道 tee 到全局观测总线）。 */
  emitRaw(event: string, data: unknown): void {
    this.dispatch(event, data);
  }

  private dispatch(event: string, data: unknown): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        try {
          h(data);
        } catch (err) {
          console.error(`[EventBus] handler error on "${event}":`, err);
        }
      }
    }
    for (const wh of this.wildcardHandlers) {
      try {
        wh(event, data);
      } catch (err) {
        console.error(`[EventBus] wildcard handler error on "${event}":`, err);
      }
    }
  }

  /** 异步触发，等待所有 handler resolve。 */
  async emitAsync<K extends keyof TMap & string>(event: K, data: TMap[K]): Promise<void> {
    const set = this.handlers.get(event);
    const promises: Promise<void>[] = [];
    if (set) {
      for (const h of set) {
        try {
          const result = h(data);
          if (result && typeof (result as Promise<void>).then === 'function') {
            promises.push(result as Promise<void>);
          }
        } catch (err) {
          console.error(`[EventBus] handler error on "${event}":`, err);
        }
      }
    }
    for (const wh of this.wildcardHandlers) {
      try {
        wh(event, data);
      } catch (err) {
        console.error(`[EventBus] wildcard handler error on "${event}":`, err);
      }
    }
    if (promises.length > 0) await Promise.all(promises);
  }

  /** 通配监听所有事件。 */
  onAny(handler: WildcardHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => { this.wildcardHandlers.delete(handler); };
  }

  /** 移除所有监听器。 */
  removeAllListeners(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }
}
