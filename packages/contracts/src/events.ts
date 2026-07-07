/**
 * 微信入站事件契约（驱动 apps/brain 角色）。change friend-add-closed-loop 首批只覆盖加友闭环相关事件；
 * 后续 change（对话主链/群/朋友圈）在此增补。EventBus 由 @aiim/kernel 提供、以本 map 泛型化。
 */
import type { AddChannel, TargetIdentity } from './friend-add';

/** 他人申请加我（被动加友）。协议 2132 归一化后。 */
export interface FriendRequestReceived {
  accountId: string;
  requestId: string;
  fromWxid?: string;
  fromNickname?: string;
  verifyText?: string;
  /** 加友来源枚举（搜手机号/群聊/名片/扫码…）。 */
  sourceType?: string;
  inRoom?: boolean;
}

/** 加友成功（好友列表实证确认后）。主动加成功或被动通过都发这个。 */
export interface FriendAccepted {
  accountId: string;
  /** 主动加友任务；被动通过可空。 */
  taskId?: string;
  wxid: string;
  /** 私聊会话标识（S:788… 前缀）。 */
  conversationId: string;
  via: 'active' | 'passive';
}

/** 加友被拒。 */
export interface FriendRejected {
  accountId: string;
  taskId: string;
  targetKey: string;
  reason?: string;
}

/** 加友申请超时未通过。 */
export interface FriendExpired {
  accountId: string;
  taskId: string;
  targetKey: string;
}

/** 任一出站命令的执行回执（绝不静默假成功：ok/err/is_svr_fail 如实回报）。 */
export interface OpResult {
  accountId: string;
  command: string;
  requestId: string;
  ok: boolean;
  /** 服务器失败标志（回执 ok 也可能 is_svr_fail=true）。 */
  isSvrFail?: boolean;
  errorCode?: number;
  errorMessage?: string;
  value?: unknown;
}

/** 加成功交棒：请对话闭环做首次打招呼（本事件不带话术，内容由对话闭环经外部 AI 产出）。 */
export interface FirstTouchNeeded {
  accountId: string;
  wxid: string;
  conversationId: string;
  taskId?: string;
}

/** 外部推来的加微指令（受理入口）。 */
export interface FriendAddRequested {
  /** 幂等键（外部指令 id）。 */
  requestId: string;
  target: TargetIdentity;
  channel?: AddChannel;
  verifyText?: string;
  sourceTag?: string;
  /** 指定承接账号（可空，空则由选号角色决定）。 */
  preferredAccountId?: string;
}

export interface WechatEventMap {
  'friend.add_requested': FriendAddRequested;
  'friend.request_received': FriendRequestReceived;
  'friend.accepted': FriendAccepted;
  'friend.rejected': FriendRejected;
  'friend.expired': FriendExpired;
  'op.result': OpResult;
  'first_touch.needed': FirstTouchNeeded;
}

export type WechatEventType = keyof WechatEventMap;
