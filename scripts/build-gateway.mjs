// 跨平台包装：按操作系统调用 build-gateway.ps1 / build-gateway.sh
// 供打包流程在 tauri build 前自动重建 gateway-bundle.tar.gz，
// 避免改了 gateway 源码却忘了重建 bundle 导致安装包跑旧逻辑。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const script = join(here, isWin ? 'build-gateway.ps1' : 'build-gateway.sh');

const { command, args } = isWin
    ? { command: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', script] }
    : { command: 'bash', args: [script] };

console.log(`[build-gateway] platform=${process.platform}, running ${script}`);
const res = spawnSync(command, args, { stdio: 'inherit' });
if (res.error) {
    console.error(`[build-gateway] 启动失败: ${res.error.message}`);
    process.exit(1);
}
if (res.status !== 0) {
    console.error(`[build-gateway] 失败，退出码 ${res.status}`);
    process.exit(res.status ?? 1);
}
