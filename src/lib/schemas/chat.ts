import { z } from 'zod'

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
 * `clientId` is a client-generated idempotency token (a UUID). A retry after a
 * dropped response reuses it, and the unique `{ channelId, clientId }` index
 * turns the second insert into a fetch-and-return of the first, never a dupe.
 */
export const messageSendSchema = z
  .object({
    content: z.string().min(1, 'Message cannot be empty').max(4000, 'Message is too long'),
    clientId: z.string().trim().min(8, 'clientId is required').max(120),
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

export { objectId }
