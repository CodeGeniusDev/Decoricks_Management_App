import { z } from 'zod'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id')

/* ---------------------------------- chat --------------------------------- */

/*
 * The sender is taken from the authenticated session on the server, never from
 * the request body — otherwise any signed-in user could post as another partner
 * or forge a system message. The client only sends the text.
 */
export const messageSchema = z
  .object({
    content: z.string().trim().min(1, 'Message cannot be empty').max(4000, 'Message is too long'),
  })
  .strict()

/* -------------------------------- products -------------------------------- */

const locations = ['sheikhupura', 'lahore'] as const

export const productSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(64),
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1, 'Category is required').max(100),
  cost: z.number().int().min(0, 'Cost cannot be negative'),
  sellingPrice: z.number().int().min(0, 'Selling price cannot be negative'),
  isActive: z.boolean().optional(),
})

export const stockSchema = z.object({
  productId: objectId,
  location: z.enum(locations, { message: 'Location must be sheikhupura or lahore' }),
  quantity: z.number().int().min(0, 'Quantity cannot be negative'),
})

export const stockTransferSchema = z
  .object({
    productId: objectId,
    quantity: z.number().int().positive('Transfer quantity must be positive'),
    fromLocation: z.enum(locations),
    toLocation: z.enum(locations),
  })
  .refine((v) => v.fromLocation !== v.toLocation, {
    message: 'Source and destination must differ',
    path: ['toLocation'],
  })

/* --------------------------------- orders --------------------------------- */

/**
 * Only `productId` and `quantity` are meaningful from the client. `productName`,
 * `unitPrice` and `total` are resolved server-side from the products
 * collection, so anything sent for them is ignored rather than trusted.
 */
export const orderItemSchema = z.object({
  productId: objectId,
  quantity: z.number().int().positive('Quantity must be positive'),
  productName: z.string().trim().min(1).optional(),
  unitPrice: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
})

export const orderSchema = z.object({
  customerName: z.string().trim().min(1, 'Customer name is required').max(200),
  customerPhone: z.string().trim().min(1, 'Customer phone is required').max(40),
  customerCity: z.string().trim().min(1, 'City is required').max(100),
  customerAddress: z.string().trim().min(1, 'Address is required').max(500),
  items: z.array(orderItemSchema).min(1, 'Add at least one item'),
  shippingCost: z.number().int().min(0).optional(),
  paymentMethod: z.string().trim().min(1).default('cod'),
  paymentStatus: z.string().trim().min(1).default('pending'),
  orderStatus: z.string().trim().min(1).default('pending'),
  codOutcome: z.string().trim().min(1).default('pending'),
  salesChannel: z.string().trim().min(1, 'Sales channel is required').max(60),
  notes: z.string().trim().max(2000).optional(),
})

export const orderStatusUpdateSchema = z.object({
  orderStatus: z.string().trim().min(1).optional(),
  paymentStatus: z.string().trim().min(1).optional(),
  codOutcome: z.string().trim().min(1).optional(),
})

/* ---------------------------------- tasks --------------------------------- */

export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const

export const taskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  description: z.string().trim().max(4000).optional(),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  assigneeName: z.string().trim().max(120).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'Due date must be YYYY-MM-DD')
    .optional()
    .or(z.literal('').transform(() => undefined)),
})

export const taskStatusUpdateSchema = z.object({
  status: z.enum(TASK_STATUSES),
})

/* -------------------------------- suppliers -------------------------------- */

export const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(200),
  contactPerson: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email('Enter a valid email').max(200).optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().min(1, 'City is required').max(100),
  address: z.string().trim().max(500).optional(),
  productsSupplied: z.array(z.string().trim().min(1).max(200)).default([]),
  notes: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
})

/* --------------------------------- budgets --------------------------------- */

export const BUDGET_PERIOD_KINDS = ['weekly', 'monthly', 'custom'] as const;

export const budgetCategorySchema = z.object({
  category: z.string().trim().min(1, 'Category is required').max(100),
  budgeted: z.number().int().min(0, 'Budget cannot be negative'),
});

export const budgetSchema = z.object({
  name: z.string().trim().min(1, 'Budget name is required').max(200),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Start date must be YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'End date must be YYYY-MM-DD'),
  /** Omitted on create means "derive from the dates"; validated against them when sent. */
  periodKind: z.enum(BUDGET_PERIOD_KINDS).optional(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  categories: z.array(budgetCategorySchema).min(1, 'Add at least one budget category'),
  approvedBy: z.string().trim().max(120).optional(),
  /** Client-generated retry guard; unique when present. */
  idempotencyKey: z.string().trim().min(8).max(120, 'Idempotency key is too long').optional(),
});

/** Partial edits keep history; `status` transitions go through the action endpoint. */
export const budgetUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Budget name is required').max(200).optional(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Start date must be YYYY-MM-DD').optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'End date must be YYYY-MM-DD').optional(),
    categories: z.array(budgetCategorySchema).min(1, 'Add at least one budget category').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes sent' });

export const budgetActionSchema = z.object({
  action: z.enum(['approve', 'archive', 'reopen']),
  reason: z.string().trim().max(500).optional(),
});