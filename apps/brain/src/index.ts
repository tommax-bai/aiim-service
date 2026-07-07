/**
 * @aiim/brain — 决策端：EventBus 装配 + 角色闭环 + RiskController + 多租户 + 行动仲裁器。
 * 首批（change friend-add-closed-loop）只含加友闭环。
 */
export { createFriendAddLoop } from './friend-add/coordinator';
export type { FriendAddLoopOptions, FriendAddLoopHandle } from './friend-add/coordinator';
export { DEFAULT_FRIEND_ADD_CONFIG } from './friend-add/types';
export type {
  BrainEventMap,
  BrainInternalEvents,
  OutboundCommand,
  GatewayPort,
  AccountRuntime,
  FriendAddConfig,
} from './friend-add/types';
