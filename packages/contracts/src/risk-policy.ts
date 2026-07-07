/**
 * 微信域风控策略（注入 @aiim/kernel 的泛型 RiskController）。
 * 这是「每域一份策略」——把内核里原本对 XHS 写死的三处判定换成微信语义：
 *   - restricted 只放行被动接待（读/回复已有好友），停一切主动触达。
 *   - warned 暂停主动加友 / 群发 / 朋友圈。
 *   - ratioGuard 预留加友通过率护栏（真实通过率接入 apps/brain 加友统计后填）。
 * 数字为初始保守标定，后续按号龄/提供方实测调整（加友是头号封号源，取最严档）。
 */
import type { RiskPolicy } from '@aiim/kernel';

export const WECHAT_RISK_ACTIONS = [
  'add_friend', // 主动加好友（头号封号源）
  'accept_friend', // 被动通过好友
  'send_message', // 发消息（首批含被动回复；主动/被动细分留待对话 change）
  'read_message', // 读消息（被动，几乎不限）
  'post_moments', // 发朋友圈
  'like_moment', // 朋友圈点赞
  'mass_send', // 群发/批量触达
] as const;
export type WechatRiskAction = (typeof WECHAT_RISK_ACTIONS)[number];

const UNLIMITED = 100_000;

export const WECHAT_RISK_POLICY: RiskPolicy<WechatRiskAction> = {
  actions: WECHAT_RISK_ACTIONS,
  quotas: {
    conservative: { add_friend: 5, accept_friend: 10, send_message: 200, read_message: UNLIMITED, post_moments: 0, like_moment: 10, mass_send: 0 },
    normal: { add_friend: 15, accept_friend: 30, send_message: 500, read_message: UNLIMITED, post_moments: 1, like_moment: 30, mass_send: 0 },
    aggressive: { add_friend: 30, accept_friend: 60, send_message: 1000, read_message: UNLIMITED, post_moments: 3, like_moment: 60, mass_send: 5 },
  },
  minuteBurstCap: { add_friend: 1, accept_friend: 2, send_message: 20, read_message: UNLIMITED, post_moments: 1, like_moment: 3, mass_send: 1 },
  hourBurstCap: { add_friend: 5, accept_friend: 10, send_message: 120, read_message: UNLIMITED, post_moments: 2, like_moment: 10, mass_send: 2 },
  // restricted：仅被动接待已有好友（读 + 回复），停主动加友/群发/朋友圈。
  restrictedAllowedActions: ['read_message', 'send_message'],
  // warned：暂停最高风险的主动动作。
  warnedPausedActions: ['add_friend', 'mass_send', 'post_moments'],
  // 加友通过率护栏（占位）：真实通过率需从加友任务统计得出，接入前恒放行。
  ratioGuard: (action) => {
    if (action !== 'add_friend') return true;
    // TODO(friend-add-closed-loop 4.5)：接入近窗加友通过率，骤降则拒/降档。
    return true;
  },
};
