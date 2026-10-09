import type { Metadata } from 'next'
import '@/app/globals.css'
import { AuthProvider } from '@/components/auth/AuthProvider'

/**
 * Root layout holds only the session provider.
 *
 * The application chrome lives in `(app)/layout.tsx` and the auth screens in
 * `(auth)/layout.tsx` instead of being switched on `pathname` here. Keeping the
 * shell out of the root layout is what lets `/login` render full-bleed without
 * a sidebar, and it means the shell is never mounted-then-hidden — which would
 * have flashed desktop chrome on a phone before hydration.
 *
 * Route groups do not appear in the URL, so `(app)/finance` is still `/finance`.
 */
export const metadata: Metadata = {
  title: 'Decoricks Management',
  description: 'Internal management app for Decoricks',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/favicon.ico',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}