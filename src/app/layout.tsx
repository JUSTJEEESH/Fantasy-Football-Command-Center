import type { Metadata, Viewport } from 'next';
import './globals.css';
import { NavBar } from '@/components/NavBar';

export const metadata: Metadata = {
  title: 'Fantasy Coach',
  description: 'Personal AI fantasy football analyst, draft assistant, and news engine.',
  appleWebApp: {
    capable: true,
    title: 'Coach',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0c10',
  width: 'device-width',
  initialScale: 1,
  // Locked so a mis-tap during a draft cannot zoom the board.
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <main className="mx-auto max-w-3xl px-4 pb-28 pt-4">{children}</main>
        <NavBar />
      </body>
    </html>
  );
}
