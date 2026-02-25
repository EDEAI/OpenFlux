#!/usr/bin/env node
/**
 * 独立 Gateway Server 启动脚本
 * 运行: npx ts-node src/gateway/start.ts
 */

import { startStandaloneGateway } from './standalone.js';

startStandaloneGateway().catch((error) => {
    console.error('Gateway 启动失败:', error);
    process.exit(1);
});
