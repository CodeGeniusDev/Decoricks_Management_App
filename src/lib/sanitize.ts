/**
 * Message-content sanitisation (SPEC §7, Phase 7 security).
 *
 * Chat is "basic text only", so anything markup-shaped is not legitimate input
 * — we remove it rather than trust the client to render it inert. The UI also
 * prints content inside a text node (React escapes), so this is defence in
 * depth: even a future consumer that interpolates raw HTML cannot execute a
 * stored payload, because none is ever stored.
 *
 * Order matters: drop whole `<script>/<style>` blocks (content included) first,
 * then strip any remaining tag-shaped run, then control characters. We never
 * HTML-encode, so a message that legitimately contains `a < b` survives intact.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function sanitizeMessageText(input: string): string {
  return (
    input
      .replace(/\r\n?/g, '\n')
      // Remove script/style blocks including their inner text.
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      // Remove any leftover tag-shaped run, including unterminated `<`.
      .replace(/<[^>]*>?/g, '')
      .replace(CONTROL_CHARS, '')
      // Collapse runs of blank lines so paste-spam cannot pad the thread.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
