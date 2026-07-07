/**
 * 服务配置层（从 env 读，缺省 fail-safe，绝不硬编码敏感值）。
 * providerMode=fake 供本地冒烟；=wework 接文档那家企微协议 API（需 baseUrl + guid）。
 */
export interface ServerConfig {
  port: number;
  providerMode: 'fake' | 'wework';
  wework: { baseUrl: string; guid: string };
  /** 受管微信号（首批从 env 逗号分隔；真实 guid↔account 映射后续接实例管理）。 */
  accountIds: string[];
  /** 加友风控档位（新号默认养号 conservative）。 */
  quotaLevel: 'conservative' | 'normal' | 'aggressive';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env.AIIM_PORT ?? '8990', 10);
  const providerMode = env.AIIM_PROVIDER === 'wework' ? 'wework' : 'fake';
  const accountIds = (env.AIIM_ACCOUNTS ?? 'acc1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const level = env.AIIM_QUOTA_LEVEL;
  const quotaLevel = level === 'normal' || level === 'aggressive' ? level : 'conservative';
  return {
    port: Number.isFinite(port) ? port : 8990,
    providerMode,
    wework: { baseUrl: env.WEWORK_BASE_URL ?? '', guid: env.WEWORK_GUID ?? '' },
    accountIds: accountIds.length > 0 ? accountIds : ['acc1'],
    quotaLevel,
  };
}
