# packages/kernel — 领域无关机制（从 AIDCP 复制内联 + 泛型化）

从 `../aidcp`（`aidcp-cloud` + `aidcp-edge`）**复制**的领域无关机制，grep≈0 的引擎层。**复制、不依赖整个 aidcp 仓**。

计划内容：
- `event-bus/`：`EventBus<TMap>`（typed EventEmitter，fire-and-forget、异常隔离、wildcard tee）——**泛型化**，微信 map 由 `packages/contracts` 提供。
- `risk/`：`RiskController<TAction>` + 状态机（normal→warned→restricted→frozen）+ 滑窗计数 + quotas + cold-start + registry。
- `pacing/`：`tempoForStatus` + `fatigueMultiplier` + clamp 骨架（拟人节奏骨架，不含浏览专属阅读模型）。
- `humanize/`：`timing`（对数正态停顿）+ `session-rhythm`（疲劳曲线）+ `reading-time`（按字数延迟）——从 aidcp-edge 复制，**切勿依赖整个 edge**（Electron/CDP/jsdom）。
- `feishu/`：messenger/token/cards/ws-receiver 管道（卡片内容微信侧重画）。
- `llm/`：providers + ChatLlmClient 接口（OpenAI 兼容）。
- `soul/`：loader + yaml（人设装载，schema 去浏览专属）。
- `comm/`：`Envelope<TType>` + makeEnvelope/parseEnvelope（若需内部 WS；MessageType 由各服务自定义）。

**纪律**：泛型化开口（`EventBus<TMap>`/`RiskController<TAction>`/`Envelope<TType>`）；lint 禁止反向依赖 `apps/*` 与 `contracts`；复制风控时消除三处 XHS 浅耦合（RiskAction 动词 / quotas 三档 / likeRatio 护栏 / zeroInteractions 放行动作）。**不抽独立发布库**，出现第二消费者再 lift-and-shift 成 `@aidcp/kernel`。
