import { authorize } from '@/lib/authorization';
import { getDatabase } from '@/lib/mongodb';
import { handleRouteError, withAuth } from '@/lib/http';
import { successResponse } from '@/lib/api-response';
import { ROLE_ALI, ROLE_AFNAN, ROLE_FOUNDER, ROLE_HASNAT } from '@/lib/roles';
import { getUserCollection } from '@/lib/models/User';

/**
 * GET /api/finance/partners
 *
 * The small, read-only list the finance screens need for the partner selector
 * and the partner filter: id and display name only, never email or hashes.
 * Reads sit behind `finance.view`, the same gate as the ledger itself.
 */
async function __GET() {
  try {
    await authorize('finance', 'view');
    const db = await getDatabase();

    const users = await getUserCollection(db)
      .find(
        { role: { $in: [ROLE_FOUNDER, ROLE_HASNAT, ROLE_ALI, ROLE_AFNAN] }, isActive: true },
        { projection: { name: 1, role: 1 } }
      )
      .sort({ createdAt: 1 })
      .toArray();

    return successResponse(
      users.map((user) => ({
        _id: user._id!.toString(),
        name: user.name,
        role: user.role,
      }))
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withAuth(__GET);
