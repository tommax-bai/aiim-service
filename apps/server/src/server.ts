/**
 * 服务装配 + HTTP 入口（apps/server）。把 kernel/contracts/store/brain/gateway 装成一个能起的进程：
 *  - GET  /health   健康检查（供部署 healthcheck）
 *  - POST /webhook  协议服务商回调入站 → 归一 → 驱动闭环
 *  - POST /intake   外部「给客户加微信」指令 → friend.add_requested
 *  - 每分钟巡视：sweepTimeouts + pollConfirms（轮询兜底）
 * provider=fake 本地冒烟；=wework 接文档那家企微协议 API。
 */
import http from 'node:http';

import { EventBus, RiskController } from '@aiim/kernel';
import { WECHAT_RISK_POLICY, type WechatRiskAction } from '@aiim/contracts';
import { InMemoryFriendAddStore } from '@aiim/store';
import { createFriendAddLoop, DEFAULT_FRIEND_ADD_CONFIG, type AccountRuntime, type BrainEventMap } from '@aiim/brain';
import { createGateway, FakeProvider, type Provider } from '@aiim/gateway';

import { loadConfig, type ServerConfig } from './config';
import { WeworkProvider } from './wework-provider';

export interface RunningServer {
  server: http.Server;
  config: ServerConfig;
  dispose(): void;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function startServer(config: ServerConfig = loadConfig()): RunningServer {
  const bus = new EventBus<BrainEventMap>();
  const store = new InMemoryFriendAddStore();
  const provider: Provider = config.providerMode === 'wework' ? new WeworkProvider(config.wework) : new FakeProvider();
  const gateway = createGateway({ bus, provider });

  const accounts: AccountRuntime[] = config.accountIds.map((accountId) => ({
    accountId,
    risk: new RiskController<WechatRiskAction>({ policy: WECHAT_RISK_POLICY, accountId, quotaLevel: config.quotaLevel }),
  }));
  const loop = createFriendAddLoop({ bus, gateway: gateway.port, store, accounts: () => accounts, config: DEFAULT_FRIEND_ADD_CONFIG });

  bus.on('first_touch.needed', (e) => console.log('[first_touch]', JSON.stringify(e)));
  bus.on('alert', (e) => console.warn('[alert]', JSON.stringify(e)));

  // 巡视：超时判失败 + 2131 漏报的轮询兜底（每分钟）。
  const timer = setInterval(() => {
    loop.sweepTimeouts(Date.now());
    void gateway.pollConfirms();
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: config.providerMode, accounts: accounts.length, ts: Date.now() }));
      return;
    }
    if (req.method === 'POST' && (req.url ?? '').startsWith('/webhook')) {
      const body = await readJson(req);
      if (config.providerMode === 'wework' && provider instanceof WeworkProvider) provider.ingestCallback(body);
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/intake') {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (!body || typeof body.requestId !== 'string' || typeof body.target !== 'object' || body.target === null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'requestId(string) + target(object) required' }));
        return;
      }
      bus.emit('friend.add_requested', body as unknown as BrainEventMap['friend.add_requested']);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: true }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[http] handler error', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('error');
      }
    });
  });

  server.listen(config.port, () => {
    console.log(`[aiim] listening on :${config.port} provider=${config.providerMode} accounts=${accounts.length}`);
  });

  return {
    server,
    config,
    dispose() {
      clearInterval(timer);
      loop.dispose();
      gateway.dispose();
      server.close();
    },
  };
}
