/**
 * @aiim/server — 可运行服务（装配 + HTTP 入口）。首批含加友闭环。
 */
export { startServer } from './server';
export type { RunningServer } from './server';
export { loadConfig } from './config';
export type { ServerConfig } from './config';
export { WeworkProvider } from './wework-provider';
export type { WeworkConfig } from './wework-provider';
