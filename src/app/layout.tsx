import type { Metadata, Viewport } from 'next'
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
  // Phase 9 PWA (design §5). The manifest makes the app installable and pins
  // brand colours; the service worker itself is registered lazily only when a
  // user enables push, never on load — so the worker is opt-in, not implied.
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Decoricks',
  },
  icons: {
    // The brand mark is raster artwork, so the whole icon set is raster: a real
    // ICO container (16/32/48 PNG payloads inside) for tabs and address bars,
    // and fixed-size PNGs everywhere a size is declared. There are deliberately
    // no `/favicon.svg` or `/icon.svg` entries — an .svg name holding PNG bytes
    // is the bug `pwa-assets.test.ts` exists to catch.
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    // iOS reads apple-touch-icon (180x180 PNG) when added to the Home Screen.
    // It must be a PNG — Safari does not use favicon.ico or the manifest here.
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#2b2b2b',
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
