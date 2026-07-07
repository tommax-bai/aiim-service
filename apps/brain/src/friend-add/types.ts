/**
 * 加友闭环的内部事件、端口与配置（apps/brain）。
 * BrainEventMap = 微信契约事件（@aiim/contracts）+ 决策端内部事件；EventBus 以它泛型化。
 */
import type { RiskController } from '@aiim/kernel';
import type {
  FriendAcceptCommand,
  FriendAddCommand,
  FriendAddFailReason,
  WechatEventMap,
  WechatRiskAction,
} from '@aiim/contracts';

/** 决策端内部（角色接力）事件，不出决策端。 */
export interface BrainInternalEvents {
  'friend.add.candidate': { taskId: string };
  'friend.add.authorized': { taskId: string; preAddDelayMs: number };
  'friend.add.deferred': { taskId: string; reason: string };
  'friend.add.rejected': { requestId: string; reason: string };
  'friend.add.failed': { taskId: string; accountId?: string; reason: FriendAddFailReason };
  alert: { accountId?: string; kind: string; detail: string };
}

export type BrainEventMap = WechatEventMap & BrainInternalEvents;

/** 出站命令下发端口（gateway 实现；测试用 mock）。执行结果经 EventBus 回流（op.result / friend.accepted…）。 */
export type OutboundCommand =
  | { type: 'friend.add'; payload: FriendAddCommand }
  | { type: 'friend.accept'; payload: FriendAcceptCommand };

export interface GatewayPort {
  send(command: OutboundCommand): void;
}

/** 一个受管微信号的运行时（含其单写风控控制器）。 */
export interface AccountRuntime {
  accountId: string;
  risk: RiskController<WechatRiskAction>;
}

export interface FriendAddConfig {
  /** pending 等对方通过的时限，超时判失败。 */
  pendingTimeoutMs: number;
  /** 单账号连续加友失败到此数即升级停手。 */
  maxConsecutiveFailures: number;
  /** 连续加友间隔中心值（执行端叠抖动、保非零下限）。 */
  preAddDelayBaseMs: number;
  /** 被动加友申请含这些关键词则挂人审、不自动通过。 */
  suspiciousKeywords?: string[];
}

export const DEFAULT_FRIEND_ADD_CONFIG: FriendAddConfig = {
  pendingTimeoutMs: 3 * 24 * 60 * 60_000, // 3 天
  maxConsecutiveFailures: 5,
  preAddDelayBaseMs: 90_000, // 90s 中心值
};
