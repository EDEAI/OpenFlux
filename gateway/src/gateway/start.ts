#!/usr/bin/env node
/**
 * Standalone Gateway Server startup script
 * Run: npx ts-node src/gateway/start.ts
 */

// Windows: StdioClientTransport for MCP SDK only enabled under Electron windowsHide
// (Judged by 'type' in process). Set process.type to make SDK correctly hide child process console windows
if (process.platform === 'win32' && !('type' in process)) {
    (process as any).type = 'renderer';
}

import { startStandaloneGateway } from './standalone.js';

startStandaloneGateway().catch((error) => {
    console.error('Gateway startup failed:', error);
    process.exit(1);
});
