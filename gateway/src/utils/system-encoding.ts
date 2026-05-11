/**
 * 系统编码检测模块
 *
 * 在 Gateway 启动时检测操作系统的实际字符编码（Code Page），
 * 供 process / windows 等工具在解码子进程输出时使用。
 *
 * 为什么需要这个：
 * - 中文 Windows：默认 CP936（GBK）
 * - 日文 Windows：CP932（Shift-JIS）
 * - 西欧 Windows：CP1252（Latin-1）
 * - UTF-8 系统（Linux/macOS/Win11 新设置）：65001
 * - Node.js 的 exec() 如果用字符串 encoding，会把 GBK bytes 当 UTF-8 解码，
 *   导致中文等多字节字符乱码。
 *
 * 解决方案：
 * - 检测 OS 实际 Code Page
 * - 所有 exec 调用改用 encoding:'buffer'，然后用正确的编码解码
 * - 如果是 65001 / UTF-8，直接当 UTF-8 解；其他 Code Page 走 iconv-lite
 */

import { execSync } from 'child_process';
import { Logger } from './logger';

const log = new Logger('SystemEncoding');

export interface SystemEncodingInfo {
    /** Windows Code Page 编号（如 936, 65001），非 Windows 为 0 */
    codePage: number;
    /** 对应的 iconv-lite 编码名（如 'gbk', 'utf-8', 'shiftjis'） */
    encoding: string;
    /** 是否已是 UTF-8（codePage === 65001 或非 Windows） */
    isUtf8: boolean;
    /** 原始检测结果字符串 */
    raw: string;
}

/** 全局编码信息（由 detectSystemEncoding 初始化） */
let _systemEncoding: SystemEncodingInfo = {
    codePage: 0,
    encoding: 'utf-8',
    isUtf8: true,
    raw: 'unknown',
};

/** Windows Code Page → iconv-lite 编码名映射 */
const CODE_PAGE_MAP: Record<number, string> = {
    936: 'gbk',       // 简体中文
    950: 'big5',      // 繁体中文
    932: 'shiftjis',  // 日文
    949: 'euc-kr',    // 韩文
    1252: 'win1252',  // 西欧
    1250: 'win1250',  // 中欧
    1251: 'win1251',  // 西里尔
    1253: 'win1253',  // 希腊
    1254: 'win1254',  // 土耳其
    1255: 'win1255',  // 希伯来
    1256: 'win1256',  // 阿拉伯
    874:  'tis620',   // 泰文
    65001: 'utf-8',   // UTF-8
    20127: 'ascii',   // ASCII
};

/**
 * 检测系统编码（在 Gateway 启动时调用一次）
 */
export function detectSystemEncoding(): SystemEncodingInfo {
    if (process.platform !== 'win32') {
        // Linux / macOS 通常是 UTF-8
        _systemEncoding = {
            codePage: 0,
            encoding: 'utf-8',
            isUtf8: true,
            raw: 'non-windows',
        };
        log.info('System encoding detected', { codePage: 0, encoding: 'utf-8', isUtf8: true });
        return _systemEncoding;
    }

    try {
        // chcp 命令返回如 "Active code page: 936"
        const raw = execSync('chcp', {
            windowsHide: true,
            timeout: 3000,
            encoding: 'buffer',
        }).toString('ascii').trim();

        // 解析 code page 数字（兼容各语言系统的 chcp 输出）
        const match = raw.match(/(\d+)\s*$/);
        const codePage = match ? parseInt(match[1], 10) : 0;
        const encoding = CODE_PAGE_MAP[codePage] || 'utf-8';
        const isUtf8 = codePage === 65001 || codePage === 0;

        _systemEncoding = { codePage, encoding, isUtf8, raw };
        log.info('System encoding detected', { codePage, encoding, isUtf8 });
    } catch (err: any) {
        log.warn('Failed to detect system encoding, defaulting to utf-8', { error: err.message });
        _systemEncoding = {
            codePage: 0,
            encoding: 'utf-8',
            isUtf8: true,
            raw: 'detection-failed',
        };
    }

    return _systemEncoding;
}

/**
 * 获取当前检测到的系统编码（已初始化后使用）
 */
export function getSystemEncoding(): SystemEncodingInfo {
    return _systemEncoding;
}

/**
 * 将子进程输出的 Buffer 按系统编码解码为字符串
 *
 * @param buf  exec 返回的 Buffer（需以 encoding:'buffer' 模式调用）
 * @returns    正确解码的 UTF-8 字符串
 */
export function decodeProcessOutput(buf: Buffer | string | null | undefined): string {
    if (!buf) return '';
    if (typeof buf === 'string') return buf;

    if (_systemEncoding.isUtf8) {
        return buf.toString('utf-8');
    }

    // 非 UTF-8：尝试用 iconv-lite 解码
    try {
        // 动态导入 iconv-lite（避免强制依赖）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const iconv = require('iconv-lite') as typeof import('iconv-lite');
        if (iconv.encodingExists(_systemEncoding.encoding)) {
            return iconv.decode(buf, _systemEncoding.encoding);
        }
    } catch {
        // iconv-lite 不可用，回退 UTF-8（比 GBK 乱码好）
    }

    // 最终回退：UTF-8
    return buf.toString('utf-8');
}

/**
 * 构建 PowerShell 脚本头部编码设置行
 *
 * 注意：这里直接设置 UTF-8，因为我们把 .ps1 文件写为 UTF-8，
 * PowerShell 读文件时需要知道输出编码以便 Node 能正确读取。
 */
export function getPsUtf8Header(): string {
    return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'\n`;
}
