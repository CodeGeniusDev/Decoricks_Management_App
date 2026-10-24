import { describe, it, expect } from 'vitest'
import { encryptBackup, decryptBackup } from '../crypto'

/**
 * The backup encryption must round-trip and must refuse tampered input —
 * an unreadable backup is a disaster, but a backup that silently restores
 * corrupted data is worse, so GCM authentication is load-bearing here.
 */
describe('backup crypto', () => {
  const passphrase = 'correct horse battery staple'

  it('round-trips arbitrary bytes', () => {
    const plain = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }), 'utf8')
    const enc = encryptBackup(plain, passphrase)
    expect(enc.equals(plain)).toBe(false)
    expect(decryptBackup(enc, passphrase).equals(plain)).toBe(true)
  })

  it('produces a different container each time (random salt + iv)', () => {
    const plain = Buffer.from('same input', 'utf8')
    const a = encryptBackup(plain, passphrase)
    const b = encryptBackup(plain, passphrase)
    expect(a.equals(b)).toBe(false)
    expect(decryptBackup(a, passphrase).equals(plain)).toBe(true)
    expect(decryptBackup(b, passphrase).equals(plain)).toBe(true)
  })

  it('fails to decrypt with the wrong passphrase', () => {
    const enc = encryptBackup(Buffer.from('secret', 'utf8'), passphrase)
    expect(() => decryptBackup(enc, 'wrong passphrase entirely')).toThrow()
  })

  it('fails loudly on a tampered ciphertext (GCM auth tag)', () => {
    const enc = encryptBackup(Buffer.from('secret payload', 'utf8'), passphrase)
    const tampered = Buffer.from(enc)
    tampered[tampered.length - 1] ^= 0xff // flip the last ciphertext byte
    expect(() => decryptBackup(tampered, passphrase)).toThrow()
  })

  it('rejects a non-backup file by its magic header', () => {
    const notABackup = Buffer.from(
      'this is definitely not a decoricks backup file at all!!',
      'utf8'
    )
    expect(() => decryptBackup(notABackup, passphrase)).toThrow(/magic|truncated|corrupt/)
  })

  it('refuses a too-short passphrase rather than encrypting weakly', () => {
    expect(() => encryptBackup(Buffer.from('x'), 'short')).toThrow(/too short/)
  })
})
