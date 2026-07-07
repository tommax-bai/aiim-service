/**
 * 加友任务领域类型（change friend-add-closed-loop）。
 * 状态机：received → account_selected → risk_gated → dispatched → pending → accepted | failed | deferred | rejected。
 */

export const FRIEND_ADD_STATES = [
  'received', // 受理去重后
  'deferred', // 无可用配额，排队
  'account_selected', // 选定承接账号
  'risk_gated', // 过加友风控闸
  'dispatched', // 已发起 add_*，等 op.result
  'pending', // 确认请求真发出，等对方通过
  'accepted', // 好友列表实证确认通过
  'failed', // 超时/被拒/被限，可换号或隔日重试
  'rejected', // 受理即拒（已好友/黑名单/无效）
] as const;
export type FriendAddState = (typeof FRIEND_ADD_STATES)[number];

export type AddChannel = 'phone' | 'wxid' | 'room' | 'card';

/** 目标身份：优先 wxid（稳定主键），仅有手机号时以手机号为次级键。 */
export interface TargetIdentity {
  wxid?: string;
  phone?: string;
}

export type FriendAddFailReason =
  | 'timeout'
  | 'rejected_by_peer'
  | 'rate_limited'
  | 'no_target'
  | 'account_frozen'
  | 'svr_fail';

export interface FriendAddTask {
  taskId: string;
  /** 承接账号（选号后填）。 */
  accountId?: string;
  target: TargetIdentity;
  channel?: AddChannel;
  state: FriendAddState;
  /** 申请验证语（人设化，可带变量）。 */
  verifyText?: string;
  /** 加友来源渠道标注（用于打标/统计）。 */
  sourceTag?: string;
  /** 目标垂类（供选号垂类匹配）。 */
  vertical?: string;
  /** dispatched 后关联 op.result / 后续事件。 */
  requestId?: string;
  failReason?: FriendAddFailReason;
  createdAt: number;
  updatedAt: number;
}

/** 去重/寻址主键：wxid 优先，退回手机号次级键。抓不到任一身份即无效。 */
export function targetKey(target: TargetIdentity): string | null {
  if (target.wxid) return `wxid:${target.wxid}`;
  if (target.phone) return `phone:${target.phone}`;
  return null;
}
