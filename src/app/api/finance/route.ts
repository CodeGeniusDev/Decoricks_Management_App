import { GET as GET_TX, POST as POST_TX } from './transactions/route'
import { withAuth } from '@/lib/http'

export const GET = withAuth(GET_TX)
export const POST = withAuth(POST_TX)
