/**
 * Backup encryption (Phase 10 Step 4).
 *
 * Backups leave the machine as a single opaque file and must be unreadable
 * without a key that does NOT live in the repository. AES-256-GCM is used with a
 * key derived from an operator-supplied passphrase via scrypt, so a weak
 * passphrase is stretched rather than used raw.
 *
 * Container layout:
 *   MAGIC(8, includes format version) | salt(16) | iv(12) | authTag(16) | ciphertext(...)
 * GCM's auth tag makes any tampering fail decryption loudly — a truncated or
 * edited backup is never silently restored.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

const MAGIC = Buffer.from('DKRBKP01', 'latin1') // "DecoricKBacKeuP" marker + format version
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/** Derive the 256-bit key from a passphrase and a per-file salt. */
const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  // N=2^14, r=8 ≈ 16 MB of scrypt memory — strong enough for a backup key and
  // within Node's default maxmem so it never fails on a constrained runner.
  scryptSync(passphrase, salt, KEY_LEN, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

/**
 * Encrypt a plaintext buffer. The passphrase must come from the environment or a
 * key file OUTSIDE the repo (see BACKUP_RECOVERY.md) — never from source.
 */
export const encryptBackup = (plain: Buffer, passphrase: string): Buffer => {
  if (!passphrase || passphrase.length < 12) {
    throw new Error('backup passphrase is missing or too short (< 12 characters)')
  }
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext])
}

/** Decrypt a container produced by {@link encryptBackup}. Throws on tampering. */
export const decryptBackup = (container: Buffer, passphrase: string): Buffer => {
  const minLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN
  if (container.length < minLen) throw new Error('backup file is truncated or corrupt')
  if (!timingSafeEqual(container.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error('backup file is not a Decoricks encrypted backup (bad magic)')
  }
  let off = MAGIC.length
  const salt = container.subarray(off, off + SALT_LEN)
  off += SALT_LEN
  const iv = container.subarray(off, off + IV_LEN)
  off += IV_LEN
  const tag = container.subarray(off, off + TAG_LEN)
  off += TAG_LEN
  const ciphertext = container.subarray(off)
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
