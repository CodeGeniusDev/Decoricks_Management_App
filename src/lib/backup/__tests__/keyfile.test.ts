/**
 * src/lib/backup/__tests__/keyfile.test.ts
 *
 * Tests for the backup-key safeguard (Stage 2 follow-up): the key file is read
 * ONLY — never created, never overwritten — and a missing, empty, or
 * group/world-readable key file is a hard refusal.
 *
 * All fixtures live in a fresh OS temp directory; nothing here touches
 * ~/.decoricks/backup.key, and tests never assert or print key MATERIAL beyond
 * values they themselves created.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBackupPassphrase, BACKUP_KEY_FILE_ENV, BACKUP_KEY_INLINE_ENV } from '../keyfile'

let dir: string

const keyPath = (name = 'backup.key') => join(dir, name)

/** Create a key file with given contents and mode. */
const makeKey = (contents = 's3cret-key-value\n', mode = 0o600, name = 'backup.key'): string => {
  const p = keyPath(name)
  writeFileSync(p, contents)
  chmodSync(p, mode)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keyfile-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readBackupPassphrase — never creates or overwrites the key file', () => {
  it('a missing key file is a hard refusal and is NOT created as a side effect', () => {
    const p = keyPath()
    expect(() => readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toThrow(
      /does not exist/
    )
    expect(existsSync(p)).toBe(false) // the reader left nothing behind
  })

  it('the refusal message states the by-hand / never-regenerate rule', () => {
    try {
      readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: keyPath('gone.key') } })
      expect.unreachable()
    } catch (e) {
      const msg = String(e)
      expect(msg).toMatch(/created ONCE, by hand/)
      expect(msg).toMatch(/never regenerated/)
      expect(msg).toMatch(/older backup/i)
    }
  })

  it('reading a valid key does not modify it (same size, same mtime, same bytes)', () => {
    const p = makeKey('unchanging-key\n')
    const before = statSync(p)
    expect(readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toBe('unchanging-key')
    const after = statSync(p)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

describe('readBackupPassphrase — contents checks', () => {
  it('refuses an empty key file', () => {
    const p = makeKey('')
    expect(() => readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toThrow(/empty/)
  })

  it('refuses a whitespace-only key file', () => {
    const p = makeKey('   \n\n')
    expect(() => readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toThrow(/empty/)
  })

  it('returns the trimmed contents of a healthy 0600 key file', () => {
    const p = makeKey('  good-key-value \n')
    expect(readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toBe('good-key-value')
  })

  it('refuses when the key path is a directory, not a regular file', () => {
    mkdirSync(keyPath('not-a-file'))
    expect(() =>
      readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: keyPath('not-a-file') } })
    ).toThrow(/not a regular file/)
  })
})

describe('readBackupPassphrase — permission checks (POSIX read bits)', () => {
  // Any group/world READ bit (0o044) must be refused; owner-only 0600 passes.
  it.each([
    ['0644 (group-readable)', 0o644],
    ['0604 (world-readable)', 0o604],
    ['0666 (all-readable)', 0o666],
    ['0650 (world-exec, group-read clear) passes', 0o650],
  ] as const)('mode %s', (_label, mode) => {
    const p = makeKey('perm-key\n', mode)
    const refuses = (mode & 0o044) !== 0
    if (refuses) {
      expect(() => readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toThrow(
        /group\/world-readable/
      )
    } else {
      expect(readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toBe('perm-key')
    }
  })

  it('0600 always passes and the error tells the operator to chmod 600', () => {
    const p = makeKey('chmod-me\n', 0o644)
    try {
      readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toMatch(/chmod 600/)
    }
    chmodSync(p, 0o600)
    expect(readBackupPassphrase({ env: { [BACKUP_KEY_FILE_ENV]: p } })).toBe('chmod-me')
  })
})

describe('readBackupPassphrase — env resolution order', () => {
  it('the inline env var is used when no file is configured', () => {
    expect(readBackupPassphrase({ env: { [BACKUP_KEY_INLINE_ENV]: 'inline-secret' } })).toBe(
      'inline-secret'
    )
  })

  it('the file takes precedence over the inline env var', () => {
    const p = makeKey('from-file\n')
    expect(
      readBackupPassphrase({
        env: { [BACKUP_KEY_FILE_ENV]: p, [BACKUP_KEY_INLINE_ENV]: 'ignored' },
      })
    ).toBe('from-file')
  })

  it('refuses loudly when neither source is set', () => {
    expect(() => readBackupPassphrase({ env: {} })).toThrow(/No backup passphrase/)
  })

  it('ignores a whitespace-only inline env and still refuses', () => {
    expect(() => readBackupPassphrase({ env: { [BACKUP_KEY_INLINE_ENV]: '   ' } })).toThrow(
      /No backup passphrase/
    )
  })
})
