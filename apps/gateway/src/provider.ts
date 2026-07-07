/**
 * 企微协议服务商抽象（apps/gateway）。执行端只经此接口调协议 API + 收归一化回调；
 * 真实实现是 HTTP 客户端（卡在先决:服务商能力摸底），本文件另附 FakeProvider 供结构闭环跑通。
 *
 * 关键：协议**无「加好友成功」回调**——出站 add_* 只拿到「受理回执」；「对方真通过」只能靠
 * FriendChange(2131) 信号 → sync_contact 增量确认目标进好友列表（实证）。这条确认逻辑在 gateway。
 */
import type { AddChannel, TargetIdentity } from '@aiim/contracts';

export interface ProviderAddResult {
  ok: boolean;
  isSvrFail?: boolean;
  errorCode?: number;
  /** 搜索/发起阶段解析到的稳定 wxid（协议 search_contact 先返 openid/wxid 再 add）。 */
  wxid?: string;
}

export interface ProviderAgreeResult {
  ok: boolean;
  isSvrFail?: boolean;
  wxid?: string;
}

/** 出站：调协议 API（账号维度，服务商内部映射到对应实例 guid）。 */
export interface ProviderClient {
  addFriend(req: { accountId: string; target: TargetIdentity; channel: AddChannel; verifyText?: string }): Promise<ProviderAddResult>;
  agreeFriend(req: { accountId: string; requestId: string }): Promise<ProviderAgreeResult>;
  /** 通讯录增量同步：返回自上次以来「新确认为好友」的 wxid（供 2131 后确认真通过）。 */
  syncContacts(accountId: string): Promise<{ wxid: string }[]>;
}

/** 入站：服务商 webhook 归一后的原始信号（gateway 再翻成标准事件）。 */
export type ProviderCallback =
  | { type: 'friend_change'; accountId: string } // 2131：只报「有变化」，需 sync 确认
  | { type: 'friend_apply'; accountId: string; requestId: string; fromWxid: string; verifyText?: string }; // 2132

export interface ProviderInbound {
  onCallback(handler: (cb: ProviderCallback) => void): () => void;
}

export type Provider = ProviderClient & ProviderInbound;

// —— Fake 实现（结构闭环 + 测试用，非生产）——

export interface FakeProviderOptions {
  /** 覆盖 addFriend 返回（测试 svr_fail 等）。默认 ok + 从 target 解析 wxid。 */
  addResult?: (req: { accountId: string; target: TargetIdentity }) => ProviderAddResult;
}

/** 由手机号/既有 wxid 派生稳定 wxid（fake：确定性映射）。 */
function deriveWxid(target: TargetIdentity): string | undefined {
  if (target.wxid) return target.wxid;
  if (target.phone) return `wx_${target.phone}`;
  return undefined;
}

export class FakeProvider implements Provider {
  private readonly handlers = new Set<(cb: ProviderCallback) => void>();
  /** 每账号待同步的新好友增量（simulatePeerAccept 推入、syncContacts 取走）。 */
  private readonly pendingDelta = new Map<string, string[]>();
  /** 被动申请 requestId → fromWxid（agreeFriend 用）。 */
  private readonly applyWxid = new Map<string, string>();

  constructor(private readonly options: FakeProviderOptions = {}) {}

  async addFriend(req: { accountId: string; target: TargetIdentity; channel: AddChannel; verifyText?: string }): Promise<ProviderAddResult> {
    if (this.options.addResult) return this.options.addResult(req);
    const wxid = deriveWxid(req.target);
    if (!wxid) return { ok: false, errorCode: 404 };
    return { ok: true, isSvrFail: false, wxid };
  }

  async agreeFriend(req: { accountId: string; requestId: string }): Promise<ProviderAgreeResult> {
    const wxid = this.applyWxid.get(req.requestId);
    return { ok: true, isSvrFail: false, wxid };
  }

  async syncContacts(accountId: string): Promise<{ wxid: string }[]> {
    const delta = this.pendingDelta.get(accountId) ?? [];
    this.pendingDelta.set(accountId, []);
    return delta.map((wxid) => ({ wxid }));
  }

  onCallback(handler: (cb: ProviderCallback) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  // —— 测试驱动 ——

  /** 模拟对方通过好友：把 wxid 排入该账号增量并触发 2131。 */
  simulatePeerAccept(accountId: string, wxid: string): void {
    const list = this.pendingDelta.get(accountId) ?? [];
    list.push(wxid);
    this.pendingDelta.set(accountId, list);
    this.fire({ type: 'friend_change', accountId });
  }

  /** 模拟收到他人好友申请（2132）。 */
  simulateFriendApply(accountId: string, requestId: string, fromWxid: string, verifyText?: string): void {
    this.applyWxid.set(requestId, fromWxid);
    this.fire({ type: 'friend_apply', accountId, requestId, fromWxid, verifyText });
  }

  private fire(cb: ProviderCallback): void {
    for (const h of this.handlers) h(cb);
  }
}
