# aiim-service

微信操作与运营服务的**后端**（AIIM 家族的 `aidcp-cloud` 对应物）。承接外部加微/运营指令，
把外部 AI（异步回调）生成的话术在微信侧「发得像真人、发得合规、并确认真送达」，统一管账号风控。

> 契约 / 设计 / openspec 的单一真源在控制仓 [`../aiim`](../aiim)（见 `../aiim/docs/business-design.md`）。
> 本仓只承载后端代码，按 openspec change 迭代。

## 结构（monorepo：apps + packages，单仓多可部署物）

```
apps/
├── gateway/    # 执行端：企微协议 HTTP 客户端 + webhook 入站归一 + 实例连接/登录态（薄, I/O 密集, 可独立扩缩容）
├── brain/      # 决策端：EventBus + RoleDispatcher + ~40 角色 + RiskController(单写) + 多租户 + 行动仲裁器 + DialogBrainProxy
├── scheduler/  # 运营心跳调度器（时间/状态驱动运营, 独立进程 cron 式；错峰 + 幂等 + fail-closed）
└── panel/      # 管理后台后端 API（独立端口, 供 aiim-console；只读投影 + 经 /api 下发指令）

packages/
├── kernel/     # 从 aidcp-cloud/aidcp-edge 复制内联 + 泛型化的领域无关机制：
│               #   event-bus(EventBus<TMap>) · risk(RiskController<TAction>+状态机+滑窗+quotas) ·
│               #   feishu 管道 · llm · pacing(tempo+fatigue) · humanize(timing/session-rhythm/reading-time) · soul loader · Envelope<TType>
├── contracts/  # 微信事件/指令契约：WechatEventMap / RoleName / MessageType(wxid/roomid 寻址) + panel API DTO
└── store/      # PG 持久化：ConversationStore(对话记忆·中转站权威) + 路由/去重/加友状态机/风控计数
```

`gateway / brain / scheduler` 用**异步事件/队列**解耦、可各自独立部署与扩缩容——进程/部署拆分，
**非 git 仓拆分**（同 monorepo 共享 `packages/contracts` 类型，无跨仓协议同步税）。

## 铁律（见 `../aiim/AGENTS.md`）

- 绝不静默假成功：加友「回执≠送达≠对方通过」、发消息「回执≠收到≠未撤回」，后置校验；外部 AI 超时/空绝不假发。
- 风控单写；配额背压 ≠ 风控信号。
- `packages/kernel` 复制内联 + 泛型化，禁止反向依赖 `apps/*` 与 `packages/contracts`；删 DOM 定位遗产。
- 复制风控时消除三处 XHS 浅耦合（RiskAction 动词 / quotas 三档 / likeRatio 护栏 / zeroInteractions 放行动作）。

## 开发

> 骨架初建，具体实现走控制仓 openspec change。

```bash
npm install        # workspaces
npm test           # 各 app/package 单测（含红线 AC-* 套件）
npm run typecheck
```
