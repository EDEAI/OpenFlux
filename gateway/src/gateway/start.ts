#!/usr/bin/env node
/**
 * 独立 Gateway Server 启动脚本
 * 运行: npx ts-node src/gateway/start.ts
 */

// Windows: MCP SDK 的 StdioClientTransport 仅在 Electron 下启用 windowsHide
// (通过 'type' in process 判断)。设置 process.type 让 SDK 正确隐藏子进程控制台窗口
if (process.platform === 'win32' && !('type' in process)) {
    (process as any).type = 'renderer';
}

import { startStandaloneGateway } from './standalone.js';

startStandaloneGateway().catch((error) => {
    console.error('Gateway startup failed:', error);
    process.exit(1);
});
