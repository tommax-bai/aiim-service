# apps/brain — 决策端（编排 + 风控 + 运营大脑）

- `EventBus`（复用 kernel，泛型化到 `WechatEventMap`）+ `RoleDispatcher` + 约 40 角色（加友闭环 / 首触 / 多轮对话 / 跟进SOP / 标签画像 / 群 / 朋友圈 / 会话守护 / 巡视风控）。
- `RiskController`（复用 kernel，单写账号终态 `normal→warned→restricted→frozen`；配额背压 ≠ 风控信号）。
- `DialogBrainProxy`：外部 AI 唯一收口（异步回调、幂等 reply_id、超时熔断、内容合规校验；超时/空/违规**绝不假发**）。
- 多租户：每 `(账号)` 一束上下文 / 预算 / 风控账号，指令定向不串号。
- **行动仲裁器**：每账号优先级队列 + 共享节奏时钟，把内部并发收敛成「一个账号像一个人操作一部手机」。
- 运行时：每 `(账号,客户)` 会话 = actor（片内串行、片间并发）；入站防抖聚合；AI 在途新消息则代号作废重来。
