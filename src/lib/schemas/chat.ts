import { z } from 'zod'
import { REFERENCE_ENTITY_TYPES } from '@/lib/chat-references'

/**
 * Phase 7 chat schemas.
 *
 * The channel id always comes from the URL path, never the body — so a client
 * cannot post into a channel it named itself, mirroring how task comments take
 * their task id from the route. The sender likewise comes from the session.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id')
export const isObjectId = (v: string): boolean => /^[0-9a-fA-F]{24}$/.test(v)

/* --------------------------------- messages -------------------------------- */

/**
 * A record reference as a client submits it: a registered entity type plus a
 * real id. The type list comes from the reference registry itself, so a new
 * referenceable module is reachable by the API the moment it is registered —
 * and never before. Nothing about the record (name, amount, status) is accepted
 * from the client at all; the server reads it back from the database.
 */
export const messageReferenceSchema = z
  .object({
    entityType: z.enum(REFERENCE_ENTITY_TYPES as [string, ...string[]]),
    entityId: objectId,
  })
  .strict()

/**
 * `clientId` is a client-generated idempotency token (a UUID). A retry after a
 * dropped response reuses it, and the unique `{ channelId, clientId }` index
 * turns the second insert into a fetch-and-return of the first, never a dupe.
 *
 * There is deliberately no `mentionIds` field: mentions are derived from
 * `content` on the server (see `@/lib/chat-mentions`), so a client cannot notify
 * a user it did not actually address in the message it stored.
 */
export const messageSendSchema = z
  .object({
    content: z.string().min(1, 'Message cannot be empty').max(4000, 'Message is too long'),
    clientId: z.string().trim().min(8, 'clientId is required').max(120),
    // One message may point at a handful of records; more than that is not a
    // chat message, it is a report, and the cap bounds the read-time fan-out.
    references: z.array(messageReferenceSchema).max(8).optional(),
  })
  .strict()

export const messageEditSchema = z
  .object({
    content: z.string().min(1, 'Message cannot be empty').max(4000).optional(),
    isDeleted: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.content !== undefined || v.isDeleted !== undefined, {
    message: 'No changes',
  })

/* --------------------------------- channels -------------------------------- */

/** Lowercase slug so `general`/`orders` stay stable and URL-safe. */
const channelKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Key must be 2-41 lowercase letters, digits or hyphens')

export const channelCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Channel name is required').max(80),
    description: z.string().trim().max(200).optional(),
    key: channelKey.optional(),
  })
  .strict()

export const channelUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Channel name is required').max(80).optional(),
    description: z.string().trim().max(200).optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'No changes' })

/* -------------------------------- read state ------------------------------- */

/** Epoch-ms watermark; omitted means "now". Clamped server-side to the newest msg. */
export const markReadSchema = z
  .object({
    lastReadAt: z.number().int().nonnegative().optional(),
  })
  .strict()

/* ---------------------------- record search ------------------------------- */

/**
 * `GET /api/chat/references` query string. `q` has a floor of 2 characters so a
 * stray keystroke cannot scan every collection, and `type` is validated against
 * the registry so an unknown type is a 400 rather than an empty result the UI
 * has to interpret.
 */
export const referenceSearchSchema = z
  .object({
    q: z.string().trim().min(2, 'Type at least 2 characters').max(80),
    type: z.enum(REFERENCE_ENTITY_TYPES as [string, ...string[]]).optional(),
  })
  .strict()

export { objectId }
