'use client'

import React, { useRef, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Toast } from '@/components/ui/Toast'
import { IconCamera } from '@/components/ui/icons'
import { ApiError, apiJson } from '@/lib/api-client'
import { MAX_IMAGE_BYTES } from '@/lib/image-signature'

/**
 * The profile-picture control: the camera affordance on the avatar, the file
 * picker it opens, the preview to be confirmed, and the way back to the initial.
 *
 * It lives on the profile screen only — that is where the account identity is
 * managed, and everywhere else (the header) is a reader, not an editor.
 *
 * Nothing about the target of these requests is chosen by the client. The upload
 * route addresses the session's own user id, so this component never sends one,
 * and a forged or mistyped id has nothing to influence.
 */

/** Mirrors what the server sniffs and accepts. A mismatch is refused at both ends. */
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/webp'

interface Draft {
  file: File
  /** `blob:` preview of the chosen file. CSP already admits `blob:` for images. */
  previewUrl: string
}

interface Notice {
  kind: 'success' | 'error' | 'info' | 'warning'
  message: string
}

const MAX_MB = Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The server's own rejection message when it has one, because the reasons it can
 * refuse — bytes that are not a supported image, a truncated file, a size over
 * the cap — are things only it can know, and a generic "upload failed" would
 * leave the user choosing the same file again.
 */
const failureMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.message) return error.message
  return 'Could not save your picture. Check your connection and try again.'
}

export function AvatarEditor() {
  const { user, refresh } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  /** Kept beside the rejection so the preview stays on screen while it is shown. */
  const [saveError, setSaveError] = useState<string | null>(null)

  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const [notice, setNotice] = useState<Notice | null>(null)

  if (!user) return null
  const hasPicture = Boolean(user.avatarUrl)

  /*
   * The object URL is revoked where it is replaced and where the preview is
   * dismissed rather than in an unmount effect. `reactStrictMode` mounts every
   * client component twice in development, so an unmount cleanup would release
   * the URL a live `<img>` is still pointing at and show a broken preview on the
   * profile screen for no real-world benefit: the browser reclaims every `blob:`
   * URL when the document goes away, and the count is bounded by how many images
   * one person previews in a sitting.
   */
  const discardDraft = (next: Draft | null): void => {
    if (draft) URL.revokeObjectURL(draft.previewUrl)
    setDraft(next)
    setSaveError(null)
  }

  const openPicker = (): void => {
    inputRef.current?.click()
  }

  const onPick = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null
    /*
     * Reset immediately, before anything else can bail out. A file input only
     * fires `change` when its value differs, so leaving the previous selection in
     * place would make "choose the same file again" a dead click after a cancel
     * or a rejected save.
     */
    event.target.value = ''
    if (!file) return

    // Client-side pre-checks exist for speed, not for safety. The server sniffs
    // the bytes and is the authority; these just save a round trip on the two
    // mistakes a person actually makes.
    if (file.type && !ACCEPTED_TYPES.has(file.type)) {
      setNotice({ kind: 'error', message: 'Only JPEG, PNG and WebP images are supported.' })
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNotice({
        kind: 'error',
        message: `That image is ${formatBytes(file.size)}. The maximum size is ${MAX_MB} MB.`,
      })
      return
    }

    discardDraft({ file, previewUrl: URL.createObjectURL(file) })
  }

  const save = async (): Promise<void> => {
    // Guards the double-click and the repeat-Enter case: a second multipart write
    // would store a second copy of the same picture and replace the first.
    if (!draft || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const form = new FormData()
      form.append('file', draft.file)
      await apiJson('/api/profile/avatar', { method: 'PUT', body: form })
      // Re-reads the session, so the new URL reaches the header and this screen
      // from the same source of truth — no full-page reload, and nothing that
      // depends on the client guessing what changed.
      await refresh()
      discardDraft(null)
      setNotice({ kind: 'success', message: 'Profile picture updated' })
    } catch (error) {
      setSaveError(failureMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (removing) return
    setRemoving(true)
    try {
      await apiJson('/api/profile/avatar', { method: 'DELETE' })
      await refresh()
      setConfirmRemove(false)
      setNotice({ kind: 'success', message: 'Profile picture removed' })
    } catch (error) {
      setConfirmRemove(false)
      setNotice({ kind: 'error', message: failureMessage(error) })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-center gap-1 self-start sm:self-center">
      <button
        type="button"
        onClick={openPicker}
        aria-label={hasPicture ? 'Change profile picture' : 'Add profile picture'}
        className="relative rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
      >
        <Avatar name={user.name} src={user.avatarUrl} size="lg" />
        {/*
         * Presentational only — the badge sits inside the button, so it must not
         * create a second stop in the tab order or a second name for the same
         * action. The button's own `aria-label` says what the camera means.
         */}
        <span
          aria-hidden="true"
          className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-raised bg-decoricks-dark text-white"
        >
          <IconCamera size={13} />
        </span>
      </button>

      {hasPicture && (
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          className="rounded-sm text-xs font-medium text-decoricks-brown underline underline-offset-2 hover:text-decoricks-brown-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
        >
          Remove picture
        </button>
      )}

      {/* The accessible control is the button above; this is how it opens the
          operating system's picker. */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        onChange={onPick}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      <Modal
        isOpen={Boolean(draft)}
        onClose={() => discardDraft(null)}
        title="Profile picture"
        description="Check the preview, then save it to your profile."
        size="sm"
        dismissible={!saving}
        footer={
          <>
            <Button variant="outline" onClick={() => discardDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col items-center gap-3 py-1">
            {/* `blob:` preview of a file that has not been uploaded anywhere yet,
                so there is no URL for an optimizer to work with — and no reason
                for one: it is displayed at a fixed 128px from local memory. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- rationale above */}
            <img
              src={draft.previewUrl}
              alt={draft.file.name}
              className="h-32 w-32 rounded-full border border-line-subtle bg-surface-sunken object-cover"
            />
            <p className="max-w-full truncate text-xs text-ink-muted">
              {draft.file.name} · {formatBytes(draft.file.size)}
            </p>
            {saveError && (
              <p
                role="alert"
                className="w-full rounded-md border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger"
              >
                {saveError}
              </p>
            )}
            <p className="text-xs text-ink-muted">JPEG, PNG or WebP, up to {MAX_MB} MB.</p>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={confirmRemove}
        onClose={() => {
          if (!removing) setConfirmRemove(false)
        }}
        title="Remove profile picture?"
        description="Your avatar goes back to your initial. You can add a picture again at any time."
        size="sm"
        dismissible={!removing}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmRemove(false)} disabled={removing}>
              Keep it
            </Button>
            <Button variant="secondary" onClick={remove} loading={removing}>
              {removing ? 'Removing…' : 'Remove picture'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          This only affects your own profile, and nothing else about your account.
        </p>
      </Modal>

      {notice && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={notice.message} type={notice.kind} onClose={() => setNotice(null)} />
        </div>
      )}
    </div>
  )
}
