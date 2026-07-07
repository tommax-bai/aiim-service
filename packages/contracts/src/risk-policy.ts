/**
 * 微信域风控策略（注入 @aiim/kernel 的泛型 RiskController）。
 * 这是「每域一份策略」——把内核里原本对 XHS 写死的三处判定换成微信语义：
 *   - restricted 只放行被动接待（读/回复已有好友），停一切主动触达。
 *   - warned 暂停主动加友 / 群发 / 朋友圈。
 *   - ratioGuard = 加友通过率护栏：近窗已决加友里通过率 < 阈值且样本足够 → 停加友（背压）。
 * 数字为初始保守标定，后续按号龄/提供方实测调整（加友是头号封号源，取最严档）。
 *
 * 通过率所需的两个「结果计数」由 apps/brain 经 RiskController.note() 记入滑窗（不占额、不门控）：
 *   - `add_friend_accepted`：主动加友被对方通过。
 *   - `add_friend_rejected`：主动加友被拒/超时未过（仅对方结果，不含 svr_fail/no_target 系统失败）。
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
  'add_friend_accepted', // 结果计数：主动加友通过（note，不占额）
  'add_friend_rejected', // 结果计数：主动加友被拒/超时（note，不占额）
] as const;
export type WechatRiskAction = (typeof WECHAT_RISK_ACTIONS)[number];

const UNLIMITED = 100_000;

/** 加友通过率护栏参数。 */
export const ADD_PASS_MIN_SAMPLES = 10; // 近窗已决加友样本 ≥ 此数才据通过率判
export const ADD_PASS_MIN_RATE = 0.3; // 通过率低于此值 → 停加友背压

export const WECHAT_RISK_POLICY: RiskPolicy<WechatRiskAction> = {
  actions: WECHAT_RISK_ACTIONS,
  quotas: {
    conservative: { add_friend: 5, accept_friend: 10, send_message: 200, read_message: UNLIMITED, post_moments: 0, like_moment: 10, mass_send: 0, add_friend_accepted: UNLIMITED, add_friend_rejected: UNLIMITED },
    normal: { add_friend: 15, accept_friend: 30, send_message: 500, read_message: UNLIMITED, post_moments: 1, like_moment: 30, mass_send: 0, add_friend_accepted: UNLIMITED, add_friend_rejected: UNLIMITED },
    aggressive: { add_friend: 30, accept_friend: 60, send_message: 1000, read_message: UNLIMITED, post_moments: 3, like_moment: 60, mass_send: 5, add_friend_accepted: UNLIMITED, add_friend_rejected: UNLIMITED },
  },
  minuteBurstCap: { add_friend: 1, accept_friend: 2, send_message: 20, read_message: UNLIMITED, post_moments: 1, like_moment: 3, mass_send: 1, add_friend_accepted: UNLIMITED, add_friend_rejected: UNLIMITED },
  hourBurstCap: { add_friend: 5, accept_friend: 10, send_message: 120, read_message: UNLIMITED, post_moments: 2, like_moment: 10, mass_send: 2, add_friend_accepted: UNLIMITED, add_friend_rejected: UNLIMITED },
  // restricted：仅被动接待已有好友（读 + 回复），停主动加友/群发/朋友圈。
  restrictedAllowedActions: ['read_message', 'send_message'],
  // warned：暂停最高风险的主动动作。
  warnedPausedActions: ['add_friend', 'mass_send', 'post_moments'],
  // 加友通过率护栏：近一日已决加友里通过率过低 → 停加友（背压，非风控信号）。
  ratioGuard: (action, count) => {
    if (action !== 'add_friend') return true;
    const accepted = count('add_friend_accepted', 'day');
    const rejected = count('add_friend_rejected', 'day');
    const resolved = accepted + rejected;
    if (resolved < ADD_PASS_MIN_SAMPLES) return true; // 样本不足，放行
    return accepted / resolved >= ADD_PASS_MIN_RATE;
  },
};
