# packages/store — 持久化（PG）

- **ConversationStore**（中转站权威）：全量消息历史 + 每联系人上下文投影（最近 N 轮/摘要），供 DialogBrainProxy 供给 AI + 运营 + 审计。
- **ContactRoutingRegistry**：会话路由（conversation_id ↔ 微信号 ↔ 外部客户）、`appinfo` 去重水位、加友任务状态机、送达/撤回回执态。
- **身份稳定化**：`wxid/roomid` 先暂存确认稳定才作主键，抓不到如实留空退次级键（防合并/拆分画像）。
- **风控持久化**：账号四态 + 配额滑窗 + 冷启动，跨重启不丢。
- 原始事件流落库（供统计/审计/补偿）。
