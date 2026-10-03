import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Decoricks Management',
  description: 'Internal management app for Decoricks',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
