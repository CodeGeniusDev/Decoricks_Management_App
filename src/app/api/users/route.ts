import { z } from 'zod'
import { getDatabase } from '@/lib/mongodb'
import {
  getUserCollection,
  userToJSON,
  type User,
} from '@/lib/models/User'
import { successResponse, validationError, errorResponse } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { ROLE_NAMES } from '@/lib/roles'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * User administration. SPEC §4.2 grants `users.*` to the Founder only, and
 * SPEC §10.2.2 Test 6 requires that a Partner cannot create users, change their
 * own role, or grant themselves permissions — so every mutation goes through
 * `requireFounder`, not the softer `authorize('users', ...)`.
 */

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/** Never let the caller set privileged fields (SPEC §10.2.3 Test 8). */
const createUserSchema = z
  .object({
    email: z.string().trim().email('Enter a valid email').max(254),
    name: z.string().trim().min(1, 'Name is required').max(120),
    role: z.enum(ROLE_NAMES as [string, ...string[]]),
    partnerId: z.string().trim().max(60).optional(),
    // A Founder may set an initial password, but it is always marked as
    // requiring a change so a shared temporary secret cannot become permanent.
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict()

export async function GET() {
  try {
    const auth = await authorize('users', 'view')

    const db = await getDatabase()
    const users = await getUserCollection(db).find({}).sort({ createdAt: 1 }).toArray()

    return successResponse({
      users: users.map(userToJSON),
      // A Partner has `users.view = false`, so this branch is unreachable for
      // them; kept explicit so a future grant cannot accidentally leak it.
      total: users.length,
      viewerRole: auth.user.role,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const meta = await getRequestMeta()
    const auth = await requireFounder({ ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    const parsed = createUserSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid user', parsed.error.flatten().fieldErrors)
    }

    const strength = validatePasswordStrength(parsed.data.password)
    if (!strength.valid) {
      return validationError('Password does not meet the security policy', strength.errors)
    }

    const db = await getDatabase()
    const users = getUserCollection(db)
    const now = new Date()

    const user: User = {
      email: parsed.data.email.trim().toLowerCase(),
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name,
      role: parsed.data.role,
      partnerId: parsed.data.partnerId || undefined,
      isActive: true,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
      sessionVersion: 1,
    }

    try {
      const result = await users.insertOne(user)
      await recordAuditEntry(db, {
        userId: auth.user._id,
        userEmail: auth.user.email,
        action: 'create_user',
        entityType: 'user',
        entityId: result.insertedId,
        newValue: { email: user.email, name: user.name, role: user.role, partnerId: user.partnerId },
        details: `Created ${user.name} (${user.email}) as ${user.role}`,
        outcome: 'success',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })

      return successResponse({ user: userToJSON({ ...user, _id: result.insertedId }) }, 201)
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return errorResponse('A user with that email already exists', 409, 'DUPLICATE_EMAIL')
      }
      throw error
    }
  } catch (error) {
    return handleRouteError(error)
  }
}