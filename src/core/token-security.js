/**
 * Token Security Engine using Web Crypto API (Cloudflare Workers & Node 22 native).
 *
 * - AES-GCM 256-bit authenticated encryption with unique random 12-byte IV per encryption.
 * - SHA-256 token fingerprinting for duplicate detection without storing plaintext tokens.
 * - Constant-time secret verification for Telegram X-Telegram-Bot-Api-Secret-Token headers.
 * - NEVER logs plaintext tokens or encryption keys.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derives a 256-bit AES-GCM CryptoKey from the TOKEN_ENCRYPTION_KEY secret.
 * Accepts either a base64 32-byte key or derives 256-bit SHA-256 key material if longer/passphrase.
 */
async function importAesKey(secretBase64OrPassphrase) {
  if (!secretBase64OrPassphrase || typeof secretBase64OrPassphrase !== 'string' || secretBase64OrPassphrase.trim().length < 16) {
    throw new Error('TOKEN_ENCRYPTION_KEY secret is missing or too short (minimum 16 chars / 32-byte base64 recommended).');
  }

  let keyBytes;
  try {
    const decoded = base64ToBytes(secretBase64OrPassphrase.trim());
    if (decoded.length === 32) {
      keyBytes = decoded;
    }
  } catch {
    // Fall back to SHA-256 derivation below
  }

  if (!keyBytes) {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secretBase64OrPassphrase.trim()));
    keyBytes = new Uint8Array(digest);
  }

  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypts a Telegram bot token with AES-256-GCM.
 * Format: "v1:<base64(iv[12] || ciphertext+authTag)>"
 */
export async function encryptBotToken(plaintextToken, encryptionSecret) {
  if (!plaintextToken || typeof plaintextToken !== 'string') {
    throw new Error('Cannot encrypt empty bot token.');
  }
  const key = await importAesKey(encryptionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(plaintextToken.trim())
  );
  const cipherBytes = new Uint8Array(encryptedBuffer);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return `v1:${bytesToBase64(combined)}`;
}

/**
 * Decrypts a stored AES-256-GCM bot token.
 */
export async function decryptBotToken(encryptedPayload, encryptionSecret) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string' || !encryptedPayload.startsWith('v1:')) {
    throw new Error('Malformed encrypted bot token payload.');
  }
  const key = await importAesKey(encryptionSecret);
  const combined = base64ToBytes(encryptedPayload.slice(3));
  if (combined.length < 28) {
    throw new Error('Corrupted encrypted bot token payload.');
  }
  const iv = combined.slice(0, 12);
  const cipherBytes = combined.slice(12);

  try {
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
    return textDecoder.decode(plainBuffer);
  } catch {
    throw new Error('Failed to decrypt bot token. Verify TOKEN_ENCRYPTION_KEY matches the key used at deployment.');
  }
}

/**
 * Computes a deterministic SHA-256 hash of a bot token for duplicate detection.
 */
export async function hashBotToken(plaintextToken) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(plaintextToken.trim()));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Generates a Telegram-compliant webhook secret_token (1-256 chars, [A-Za-z0-9_-]).
 */
export function generateWebhookSecret() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(randomBytes);
}

/**
 * Generates a unique internal multi-tenant bot ID (e.g. bot_a1b2c3d4e5f6a7b8).
 */
export function generateBotId() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(10));
  return `bot_${bytesToHex(randomBytes)}`;
}

/**
 * Constant-time string comparison to prevent timing side-channels on webhook secrets and API tokens.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bytesA = textEncoder.encode(a);
  const bytesB = textEncoder.encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}
