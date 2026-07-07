# packages/contracts — 微信域契约（每域一份，不跨域共享）

微信事件/指令契约 + panel API DTO，是 apps 之间与 service↔console 的类型单一真源。

- `WechatEventMap`：入站事件（`friend.request_received` / `friend.accepted` / `message.received` / `group.*` / `moments.*` / `account.*` / `op.result` / `send.receipt` / `risk.limit_hit` …）。
- `RoleName`：约 40 个微信角色枚举（加友闭环 / 首触 / 对话 / 跟进 / 标签 / 群 / 朋友圈 / 守护 / 巡视）。
- `MessageType` / 指令契约：出站原子命令（`friend.add` / `friend.accept` / `message.send` / `tag.set` / `group.*` / `moments.*` / `contact.fetch`），**用稳定 `wxid` / `roomid` 寻址**；带可选时间指令（readDelayMs / typingMs / interMsgMs / preAddDelayMs）。
- **删** AIDCP 的 `anchor.get` / `select.request` / `plan.request` 整套 DOM 定位——微信不需要。
- panel API DTO：console ↔ panel 的读写类型。
