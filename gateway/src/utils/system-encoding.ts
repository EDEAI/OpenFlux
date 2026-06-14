/**
 * System coding detection module
 *
 * Detect the actual character encoding (Code Page) of the operating system when the Gateway starts,
 * For use by tools such as process/windows when decoding child process output.
 *
 * Why you need this:
 * - Chinese Windows: Default CP936 (GBK)
 * - Japanese Windows: CP932 (Shift-JIS)
 * - Western European Windows: CP1252 (Latin-1)
 * - UTF-8 systems (Linux/macOS/Win11 new settings): 65001
 * - If string encoding is used in Node.js' exec(), GBK bytes will be decoded as UTF-8.
 *   This causes multi-byte characters such as Chinese to be garbled.
 *
 * Solution:
 * - Detect OS actual Code Page
 * - All exec calls use encoding:'buffer' instead, then decode with the correct encoding
 * - If it is 65001 / UTF-8, directly solve it as UTF-8; for other Code Pages, go to iconv-lite
 */

import { execSync } from 'child_process';
import { Logger } from './logger';

const log = new Logger('SystemEncoding');

export interface SystemEncodingInfo {
    /** Windows Code Page number (such as 936, 65001), non-Windows is 0 */
    codePage: number;
    /** Corresponding iconv-lite encoding name (such as 'gbk', 'utf-8', 'shiftjis') */
    encoding: string;
    /** Is it already UTF-8 (codePage === 65001 or non-Windows) */
    isUtf8: boolean;
    /** Original detection result string */
    raw: string;
}

/** Global encoding information (initialized by detectSystemEncoding) */
let _systemEncoding: SystemEncodingInfo = {
    codePage: 0,
    encoding: 'utf-8',
    isUtf8: true,
    raw: 'unknown',
};

/** Windows Code Page -> iconv-lite encoding name mapping */
const CODE_PAGE_MAP: Record<number, string> = {
    936: 'gbk',       // Simplified Chinese
    950: 'big5',      // Traditional Chinese
    932: 'shiftjis',  // Japanese
    949: 'euc-kr',    // Korean
    1252: 'win1252',  // Western Europe
    1250: 'win1250',  // Central Europe
    1251: 'win1251',  // Cyrillic
    1253: 'win1253',  // Greece
    1254: 'win1254',  // Türkiye
    1255: 'win1255',  // Hebrew
    1256: 'win1256',  // Arab
    874:  'tis620',   // Thai
    65001: 'utf-8',   // UTF-8
    20127: 'ascii',   // ASCII
};

/**
 * Detect system encoding (called once when Gateway starts)
 */
export function detectSystemEncoding(): SystemEncodingInfo {
    if (process.platform !== 'win32') {
        // Linux/macOS usually UTF-8
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
        // The chcp command returns "Active code page: 936"
        const raw = execSync('chcp', {
            windowsHide: true,
            timeout: 3000,
            encoding: 'buffer',
        }).toString('ascii').trim();

        // Parse code page numbers (compatible with chcp output of various language systems)
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
 * Get the currently detected system encoding (used after initialization)
 */
export function getSystemEncoding(): SystemEncodingInfo {
    return _systemEncoding;
}

/**
 * Decode the Buffer output by the subprocess into a string according to the system encoding
 *
 * @param Buffer returned by buf exec (needs to be called in encoding:'buffer' mode)
 * @returns correctly decoded UTF-8 string
 */
export function decodeProcessOutput(buf: Buffer | string | null | undefined): string {
    if (!buf) return '';
    if (typeof buf === 'string') return buf;

    if (_systemEncoding.isUtf8) {
        return buf.toString('utf-8');
    }

    // Non-UTF-8: Try decoding with iconv-lite
    try {
        // Dynamically import iconv-lite (avoid forced dependencies)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const iconv = require('iconv-lite') as typeof import('iconv-lite');
        if (iconv.encodingExists(_systemEncoding.encoding)) {
            return iconv.decode(buf, _systemEncoding.encoding);
        }
    } catch {
        // iconv-lite is not available, fallback to UTF-8 (better than GBK garbled code)
    }

    // Final fallback: UTF-8
    return buf.toString('utf-8');
}

/**
 * Build PowerShell script header encoding settings line
 *
 * Note: Set UTF-8 directly here, because we write the.ps1 file as UTF-8,
 * When PowerShell reads a file, it needs to know the output encoding so that Node can read it correctly.
 */
export function getPsUtf8Header(): string {
    return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'\n`;
}
