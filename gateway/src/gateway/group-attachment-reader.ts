import { realpathSync, readFileSync, statSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import type { ToolResult } from '../tools/types';

/** Only application-recorded files inside this Project's attachment cache qualify. */
export function isCachedGroupAttachment(root: string, path: string): boolean {
    try {
        const delta = relative(realpathSync(root), realpathSync(path));
        return !!delta && !isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`)
            && statSync(path).isFile();
    } catch { return false; }
}

export async function readGroupAttachment(path: string, name: string, type: string, offset = 0): Promise<ToolResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000) return { success: false, error: '附件读取位置无效或超出单文件读取上限' };
    const size = statSync(path).size;
    if (size > 50 * 1024 * 1024) return { success: false, error: '附件超过 50MB 读取限制' };
    if (type === 'image') {
        if (size > 10 * 1024 * 1024) return { success: false, error: '图片超过模型单次读取的 10MB 限制' };
        const data = readFileSync(path);
        const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
            : data[0] === 255 && data[1] === 216 ? 'image/jpeg'
            : data.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
            : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
            : undefined;
        if (!mime) return { success: false, error: '附件不是可识别的 PNG、JPEG、GIF 或 WebP 图片' };
        return { success: true, data: { name, size }, images: [{ mimeType: mime, data: data.toString('base64') }] };
    }
    // Reuse native attachment extraction, including PDF and Office documents;
    // group understanding does not require unrestricted local file tools.
    const { extractFileText } = await import('../utils/file-reader');
    const result = await extractFileText(path, offset + 20001);
    if (result.error) return { success: false, error: result.error };
    const more = result.truncated === true || result.text.length > offset + 20000;
    return { success: true, data: { name, text: result.text.slice(offset, offset + 20000),
        offset, next_offset: more ? offset + 20000 : null, truncated: more, type: result.type } };
}
