import { successResponse } from '@/lib/api-response'
import { handleRouteError } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getRoleCollection } from '@/lib/models/User'
import { getDatabase } from '@/lib/mongodb'

export const dynamic = 'force-dynamic'

/**
 * Role documents as seeded from SPEC Appendix A. Viewing requires `users.view`
 * (Founder only per §4.2), which the permissions matrix screen depends on.
 */
export async function GET() {
  try {
    await authorize('users', 'view')

    const db = await getDatabase()
    const roles = await getRoleCollection(db).find({}).sort({ name: 1 }).toArray()

    return successResponse({
      roles: roles.map((role) => ({
        _id: role._id?.toString(),
        name: role.name,
        displayName: role.displayName,
        permissions: role.permissions,
        updatedAt: role.updatedAt,
      })),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
