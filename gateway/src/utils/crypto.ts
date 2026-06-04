/**
 * AES-256-GCM encryption and decryption tool
 * Used to decrypt the LLM API Key issued by the Router
 */

import { createHash, createDecipheriv } from 'crypto';

/**
 * Derive AES-256 key from appId (consistent with Go side)
 */
function deriveKey(appId: string): Buffer {
    return createHash('sha256').update(appId + appId).digest();
}

/**
 * AES-256-GCM decryption (corresponds to Go end encryptAESGCM)
 */
export function decryptAPIKey(
    encryptedBase64: string,
    ivBase64: string,
    appId: string,
): string {
    const key = deriveKey(appId);
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const iv = Buffer.from(ivBase64, 'base64');

    // GCM: The last 16 bytes are the auth tag
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

