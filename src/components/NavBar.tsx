'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Bottom tab bar — thumb-reachable on a phone, which is where this is used.
 * Draft is centre and visually emphasised because on August 30 it is the only
 * tab that matters.
 *
 * Five is the limit before the targets get too small for a thumb, so the
 * player board is reached from Home rather than given a tab of its own — it is
 * a browsing surface, and the four here are the ones you open with a decision
 * to make.
 */
const TABS: ReadonlyArray<{
  href: string;
  label: string;
  icon: string;
  primary?: boolean;
}> = [
  { href: '/', label: 'Home', icon: '◆' },
  { href: '/plan', label: 'Plan', icon: '◇' },
  { href: '/draft', label: 'Draft', icon: '▲', primary: true },
  { href: '/news', label: 'News', icon: '◈' },
  { href: '/team', label: 'Team', icon: '▣' },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-3xl">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              <span className={tab.primary ? 'text-xl' : 'text-lg'}>{tab.icon}</span>
              <span className={tab.primary ? 'font-semibold' : ''}>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
