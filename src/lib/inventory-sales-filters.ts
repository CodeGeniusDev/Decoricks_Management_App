import { karachiDateInputRange } from '@/lib/finance'

/**
 * Shared MongoDB filter builders for the Phase 5 list and export routes.
 *
 * `GET /api/products/export` must honour exactly the filters
 * `GET /api/products` honours, or the CSV button labelled "export what I'm
 * looking at" would be a lie. Building the filter twice in two files is how
 * that promise breaks the first time someone adds a parameter to one of them,
 * so both routes call these functions and only these functions.
 *
 * Date params are plain `YYYY-MM-DD` civil dates typed on the Karachi calendar
 * and converted here to the inclusive UTC instants the documents are stored in.
 */

/** Escape a user-typed search string so it is matched literally, not as regex. */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Combine `$and` clauses; an empty list means "no filter at all". */
const combine = (clauses: Record<string, unknown>[]): Record<string, unknown> =>
  clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses }

export interface ProductFilterParams {
  search?: string
  category?: string
  /** `'true'` | `'false'` | anything else (which means "both"). */
  active?: string | null
}

export function buildProductFilter(params: ProductFilterParams): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  const search = params.search?.trim()
  if (search) {
    const safe = escapeRegex(search)
    clauses.push({
      $or: [{ name: { $regex: safe, $options: 'i' } }, { sku: { $regex: safe, $options: 'i' } }],
    })
  }
  const category = params.category?.trim()
  if (category) clauses.push({ category })
  if (params.active === 'true') clauses.push({ isActive: true })
  if (params.active === 'false') clauses.push({ isActive: false })
  return combine(clauses)
}

export interface OrderFilterParams {
  search?: string
  status?: string
  paymentStatus?: string
  channel?: string
  /** Ship-from location. */
  location?: string
  from?: string
  to?: string
}

/**
 * Orders list filter. `search` covers the order number and the customer's name
 * or phone, because that is how a courier complaint is actually looked up.
 */
export function buildOrderFilter(params: OrderFilterParams): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []

  const search = params.search?.trim()
  if (search) {
    const safe = escapeRegex(search)
    clauses.push({
      $or: [
        { orderNumber: { $regex: safe, $options: 'i' } },
        { customerName: { $regex: safe, $options: 'i' } },
        { customerPhone: { $regex: safe, $options: 'i' } },
      ],
    })
  }

  const status = params.status?.trim()
  if (status) clauses.push({ orderStatus: status })
  const paymentStatus = params.paymentStatus?.trim()
  if (paymentStatus) clauses.push({ paymentStatus })
  const channel = params.channel?.trim()
  if (channel) clauses.push({ salesChannel: channel })
  const location = params.location?.trim()
  if (location) clauses.push({ shipFromLocation: location })

  const dateFilter = karachiDayWindow(params.from, params.to)
  if (dateFilter) clauses.push({ createdAt: dateFilter })

  return combine(clauses)
}

/**
 * Inclusive UTC window across two Karachi civil dates, or `null` when neither
 * bound was supplied. Mirrors what every Phase 5 read route already does, in
 * one place so an export cannot cover a different window than its list.
 */
export function karachiDayWindow(
  from?: string,
  to?: string
): { $gte?: Date; $lte?: Date } | null {
  const filter: { $gte?: Date; $lte?: Date } = {}
  if (from) {
    const range = karachiDateInputRange(from)
    if (range) filter.$gte = range.start
  }
  if (to) {
    const range = karachiDateInputRange(to)
    if (range) filter.$lte = range.end
  }
  return Object.keys(filter).length > 0 ? filter : null
}

/** Read the query params a products list or export understands. */
export function productParamsFromUrl(url: URL): ProductFilterParams {
  return {
    search: url.searchParams.get('search') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    active: url.searchParams.get('active'),
  }
}

/** Read the query params an orders list or export understands. */
export function orderParamsFromUrl(url: URL): OrderFilterParams {
  return {
    search: url.searchParams.get('search') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    paymentStatus: url.searchParams.get('paymentStatus') ?? undefined,
    channel: url.searchParams.get('channel') ?? undefined,
    location: url.searchParams.get('location') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  }
}
