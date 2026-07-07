/**
 * 可运行入口（bootstrap）。`npm start` / `tsx apps/server/src/main.ts` 启动服务。
 */
import { startServer } from './server';

const running = startServer();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[aiim] ${sig} received, shutting down`);
    running.dispose();
    process.exit(0);
  });
}
