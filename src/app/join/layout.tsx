// ============================================================
// /join/[token] layout — minimal full-bleed dark shell.
//
// Retired invitation URLs remain outside the dashboard shell so the
// unavailable-link message is readable for both signed-in and anonymous
// visitors.
//
// Referrer-Policy: no-referrer
//   The plaintext invite token lives in the URL path. Without
//   this header, any externally-loaded resource (third-party
//   font, CDN script, image) would receive the full join URL in
//   its `Referer` header. The /join page doesn't currently load
//   anything external, but `Referrer-Policy: no-referrer` is a
//   cheap belt-and-braces guard against future regressions
//   accidentally leaking tokens. Per Next.js 16's `metadata`
//   export, this surfaces as `<meta name="referrer" content="no-referrer">`.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  referrer: 'no-referrer',
  // Belt-and-braces against an invite URL ending up in search
  // results if a join page is ever crawled.
  robots: { index: false, follow: false },
};

export default function JoinLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      {children}
    </div>
  );
}
