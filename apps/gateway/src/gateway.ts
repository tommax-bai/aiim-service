/**
 * 微信协议网关（执行端）。薄：调服务商 API 执行原子操作、把回调归一成标准事件、如实回报，**不做决策**。
 * 承载 change friend-add-closed-loop task 3.x：
 *  - 出站 friend.add/friend.accept → 服务商 → 归一 op.result（回执 ok/is_svr_fail 如实回报）。
 *  - 入站 2132 → friend.request_received；2131 → sync_contacts 增量 → 确认真通过 → friend.accepted（实证）。
 * 多租户（4.7）：pendingConfirms 按 (accountId, wxid) 分键，op.result/friend.accepted 带 accountId，不串号。
 */
import { jitterAround, type EventBus } from '@aiim/kernel';
import type { BrainEventMap, GatewayPort, OutboundCommand } from '@aiim/brain';
import type { Provider, ProviderCallback } from './provider';

interface PendingConfirm {
  accountId: string;
  taskId?: string;
  via: 'active' | 'passive';
}

/** 执行端拟人节奏（云端给中心值 preAddDelayMs，这里叠抖动 + 保间隔）。可注入以便测试。 */
export interface GatewayPacing {
  /** 围绕中心值叠抖动，默认乘性 lognormal。 */
  jitter?: (centerMs: number) => number;
  /** 等待 ms，默认真实 setTimeout。测试注入立即返回。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface GatewayHandle {
  port: GatewayPort;
  dispose(): void;
}

function confirmKey(accountId: string, wxid: string): string {
  return `${accountId}::${wxid}`;
}

function convId(wxid: string): string {
  return `S:${wxid}`; // 私聊会话前缀
}

export function createGateway(opts: { bus: EventBus<BrainEventMap>; provider: Provider; clock?: () => number; pacing?: GatewayPacing }): GatewayHandle {
  const { bus, provider } = opts;
  const pendingConfirms = new Map<string, PendingConfirm>();
  const jitter = opts.pacing?.jitter ?? ((ms: number) => jitterAround(ms, { min: 1000 }));
  const sleep = opts.pacing?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 每账号加友串行链：连续加友一个接一个，各自前置一段拟人间隔（对外像一个人在操作）。
  const addChains = new Map<string, Promise<unknown>>();
  function enqueueAdd(accountId: string, fn: () => Promise<void>): void {
    const prev = addChains.get(accountId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    addChains.set(accountId, next.then(() => undefined, () => undefined));
  }

  async function onFriendChange(accountId: string): Promise<void> {
    const delta = await provider.syncContacts(accountId);
    for (const { wxid } of delta) {
      const key = confirmKey(accountId, wxid);
      const pend = pendingConfirms.get(key);
      if (!pend) continue; // 非我方待确认的好友变化，忽略
      pendingConfirms.delete(key);
      bus.emit('friend.accepted', {
        accountId,
        taskId: pend.taskId,
        wxid,
        conversationId: convId(wxid),
        via: pend.via,
      });
    }
  }

  function onCallback(cb: ProviderCallback): void {
    if (cb.type === 'friend_apply') {
      bus.emit('friend.request_received', {
        accountId: cb.accountId,
        requestId: cb.requestId,
        fromWxid: cb.fromWxid,
        verifyText: cb.verifyText,
      });
      return;
    }
    // friend_change：只报有变化，去 sync 确认（实证）。
    void onFriendChange(cb.accountId);
  }

  const unsub = provider.onCallback(onCallback);

  const port: GatewayPort = {
    send(command: OutboundCommand): void {
      if (command.type === 'friend.add') {
        const p = command.payload;
        // 按账号串行 + 前置拟人间隔（执行端叠抖动，保非零下限）。
        enqueueAdd(p.accountId, async () => {
          const delayMs = p.preAddDelayMs ? jitter(p.preAddDelayMs) : 0;
          if (delayMs > 0) await sleep(delayMs);
          const res = await provider.addFriend({ accountId: p.accountId, target: p.target, channel: p.channel, verifyText: p.verifyText });
          bus.emit('op.result', {
            accountId: p.accountId,
            command: 'friend.add',
            requestId: p.requestId,
            ok: res.ok,
            isSvrFail: res.isSvrFail,
            errorCode: res.errorCode,
          });
          // 回执 ok 且拿到稳定 wxid → 登记待确认（真通过仍要等 2131+sync 实证）。
          if (res.ok && !res.isSvrFail && res.wxid) {
            pendingConfirms.set(confirmKey(p.accountId, res.wxid), { accountId: p.accountId, taskId: p.taskId, via: 'active' });
          }
        });
        return;
      }
      // friend.accept（被动通过）
      const p = command.payload;
      void (async () => {
        const res = await provider.agreeFriend({ accountId: p.accountId, requestId: p.requestId });
        bus.emit('op.result', { accountId: p.accountId, command: 'friend.accept', requestId: p.requestId, ok: res.ok, isSvrFail: res.isSvrFail });
        if (res.ok && res.wxid) {
          pendingConfirms.set(confirmKey(p.accountId, res.wxid), { accountId: p.accountId, via: 'passive' });
        }
      })();
    },
  };

  return {
    port,
    dispose() {
      unsub();
      pendingConfirms.clear();
    },
  };
}
