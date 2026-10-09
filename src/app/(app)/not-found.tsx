import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/**
 * 404 boundary for unknown routes. Kept server-rendered so it works even when a
 * page segment fails to load.
 */
export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto py-12">
      <Card variant="default" className="p-8">
        <p className="text-sm font-medium text-decoricks-brown mb-2">404</p>
        <h1 className="text-xl font-bold text-decoricks-dark mb-2">Page not found</h1>
        <p className="text-sm text-decoricks-dark/60 mb-6">
          That page does not exist. It may have been renamed, or the link may be wrong.
        </p>
        <Button variant="primary" href="/">
          Go to dashboard
        </Button>
      </Card>
    </div>
  )
}