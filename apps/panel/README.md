# apps/panel — 管理后台后端（panel API）

`aiim-console` 前端的进程内后端：HTTP `/api` + 鉴权 + 只读投影 + 经 `/api` 下发指令。独立端口，与对外集成隔离。

- 只读：账号列表 / 健康度 / 风控状态 / 会话与对话记忆投影 / 加友任务 / 原始事件流 / 运营统计。
- 下发：运营指令（暂停/恢复账号、调档、触发运营任务、审批高风险动作等）经 `apps/brain` 落地。
- **console 绝不直连微信网关**——所有读写都经本 API。
- DTO 契约在 `packages/contracts`，是 console ↔ service 的类型单一真源。
