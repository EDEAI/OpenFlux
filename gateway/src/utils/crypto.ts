/**
 * AES-256-GCM 加解密工具
 * 用于解密 Router 下发的 LLM API Key
 */

import { createHash, createDecipheriv } from 'crypto';

/**
 * 从 appId 派生 AES-256 密钥（与 Go 端一致）
 */
function deriveKey(appId: string): Buffer {
    return createHash('sha256').update(appId + appId).digest();
}

/**
 * AES-256-GCM 解密（对应 Go 端 encryptAESGCM）
 */
export function decryptAPIKey(
    encryptedBase64: string,
    ivBase64: string,
    appId: string,
): string {
    const key = deriveKey(appId);
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const iv = Buffer.from(ivBase64, 'base64');

    // GCM: 最后 16 字节是 auth tag
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return decrypted.toString('utf-8');
}

