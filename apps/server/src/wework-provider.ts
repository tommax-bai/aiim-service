/**
 * 企微协议服务商真实实现（wework.apifox.cn 文档那家）。fetch 直连、账号维度、guid 标识实例。
 *
 * ⚠️ 未经真机核实的字段解析（search_contact 返回结构、sync_contact 的 string 解析、各 wxid 字段名）
 * 均做防御 + 标 TODO(0.1)——这些要拿到真 guid 实例后按实测校准。结构与我方 Provider 契约对齐，
 * 服务能起、能收发 webhook；真加人依赖 baseUrl+guid 配好且字段核实。
 */
import type {
  Provider,
  ProviderAddResult,
  ProviderAgreeResult,
  ProviderCallback,
} from '@aiim/gateway';
import type { AddChannel, TargetIdentity } from '@aiim/contracts';

export interface WeworkConfig {
  baseUrl: string;
  guid: string;
}

/** 从任意对象里尽力取一个稳定 wxid（788… 外部联系人）。TODO(0.1)：按实测字段名收敛。 */
function pickWxid(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of ['wxid', 'user_id', 'userid', 'openid', 'external_userid']) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export class WeworkProvider implements Provider {
  private readonly handlers = new Set<(cb: ProviderCallback) => void>();
  /** 每账号 sync_contact 游标（首次空=全量）。 */
  private readonly seqCursor = new Map<string, string>();

  constructor(private readonly cfg: WeworkConfig) {}

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guid: this.cfg.guid, ...body }),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error_code: -1, error_message: 'non-json response', raw: text };
    }
  }

  async addFriend(req: { accountId: string; target: TargetIdentity; channel: AddChannel; verifyText?: string }): Promise<ProviderAddResult> {
    try {
      // 手机号搜索加：search_contact(type=1) → openid → add_search_wx_contact。
      if (req.channel === 'phone' && req.target.phone) {
        const found = await this.post('/contact/search_contact', { type: 1, keyword: req.target.phone });
        if ((found.error_code ?? 0) !== 0) return { ok: false, isSvrFail: true, errorCode: Number(found.error_code) };
        const data = (found.data ?? found) as Record<string, unknown>;
        const openid = typeof data.openid === 'string' ? data.openid : undefined;
        const wxTicket = typeof data.wx_ticket === 'string' ? data.wx_ticket : undefined;
        if (!openid) return { ok: false, errorCode: 404 }; // 搜不到 = no_target
        const added = await this.post('/contact/add_search_wx_contact', {
          openid,
          wx_ticket: wxTicket,
          verify: req.verifyText ?? '',
        });
        const ok = (added.error_code ?? 0) === 0;
        return { ok, isSvrFail: !ok, errorCode: Number(added.error_code ?? 0), wxid: pickWxid(added.data) ?? openid };
      }
      // 群成员加
      if (req.channel === 'room' && req.target.wxid) {
        const added = await this.post('/room/add_room_contact', { user_id: req.target.wxid, verify: req.verifyText ?? '' });
        const ok = (added.error_code ?? 0) === 0;
        return { ok, isSvrFail: !ok, wxid: req.target.wxid };
      }
      // 已有 wxid 但只能手机号搜（协议限制）：诚实报无法发起。
      return { ok: false, errorCode: 400 };
    } catch (err) {
      console.error('[wework] addFriend error', err);
      return { ok: false, isSvrFail: true };
    }
  }

  async agreeFriend(req: { accountId: string; requestId: string }): Promise<ProviderAgreeResult> {
    try {
      const res = await this.post('/contact/agree_contact', { user_id: req.requestId });
      const ok = (res.error_code ?? 0) === 0;
      return { ok, isSvrFail: !ok, wxid: pickWxid(res.data) };
    } catch (err) {
      console.error('[wework] agreeFriend error', err);
      return { ok: false, isSvrFail: true };
    }
  }

  async syncContacts(accountId: string): Promise<{ wxid: string }[]> {
    try {
      const seq = this.seqCursor.get(accountId) ?? '';
      const res = await this.post('/contact/sync_contact', { seq });
      const data = res.data ?? res;
      // TODO(0.1): 文档称返回 string 需自解析；这里防御性抽取 wxid 列表 + 推进游标。
      const list = Array.isArray((data as Record<string, unknown>).contacts)
        ? ((data as Record<string, unknown>).contacts as unknown[])
        : Array.isArray(data)
          ? (data as unknown[])
          : [];
      const nextSeq = (data as Record<string, unknown>).seq;
      if (typeof nextSeq === 'string') this.seqCursor.set(accountId, nextSeq);
      const wxids: { wxid: string }[] = [];
      for (const item of list) {
        const wxid = pickWxid(item);
        if (wxid) wxids.push({ wxid });
      }
      return wxids;
    } catch (err) {
      console.error('[wework] syncContacts error', err);
      return [];
    }
  }

  /** 由 HTTP 服务把收到的 webhook body 喂进来，归一为 ProviderCallback 并分发。 */
  ingestCallback(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const body = raw as Record<string, unknown>;
    const notifyType = Number(body.notify_type);
    const accountId = typeof body.guid === 'string' ? body.guid : String(body.accountId ?? '');
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (notifyType === 2131) {
      this.fire({ type: 'friend_change', accountId });
    } else if (notifyType === 2132) {
      this.fire({
        type: 'friend_apply',
        accountId,
        requestId: String(data.user_id ?? data.requestId ?? ''),
        fromWxid: pickWxid(data) ?? '',
        verifyText: typeof data.verify === 'string' ? data.verify : undefined,
      });
    }
    // 其它 notify_type（新消息 11010 等）在对话 change 接入。
  }

  onCallback(handler: (cb: ProviderCallback) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  private fire(cb: ProviderCallback): void {
    for (const h of this.handlers) h(cb);
  }
}
