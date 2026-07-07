/**
 * 微信出站指令契约（决策端 → 执行端 gateway）。用稳定 wxid/roomid 寻址，
 * **不含** AIDCP 的 anchor.get/select.request/plan.request 那套 DOM 定位。
 * 时间指令（preAddDelayMs 等）中心值由决策端算、执行端叠抖动。
 */
import type { AddChannel, TargetIdentity } from './friend-add';

/** 发起加好友。 */
export interface FriendAddCommand {
  accountId: string;
  taskId: string;
  target: TargetIdentity;
  channel: AddChannel;
  verifyText?: string;
  remark?: string;
  /** 连续加友的拟人间隔中心值（执行端叠 lognormal 抖动、保非零下限）。 */
  preAddDelayMs?: number;
}

/** 通过他人好友申请（被动加友）。 */
export interface FriendAcceptCommand {
  accountId: string;
  requestId: string;
  preDelayMs?: number;
}

export interface WechatCommandMap {
  'friend.add': FriendAddCommand;
  'friend.accept': FriendAcceptCommand;
}

export type WechatCommandType = keyof WechatCommandMap;
