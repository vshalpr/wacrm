import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";

export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformAdmin();
  } catch {
    notFound();
  }
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <Link href="/platform/customers" className="font-semibold">ReliCRM · Platform</Link>
          <span className="text-sm text-muted-foreground">Customer administration</span>
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>
    </div>
  );
}
