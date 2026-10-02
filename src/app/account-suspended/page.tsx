import Link from "next/link";

export default function AccountUnavailablePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6 text-center">
        <h1 className="text-xl font-semibold">CRM access unavailable</h1>
        <p className="text-sm text-muted-foreground">
          This customer account is paused or your team membership is disabled.
          Contact your account administrator for help. Password recovery remains available.
        </p>
        <Link className="text-sm text-primary underline underline-offset-4" href="/forgot-password">
          Reset password
        </Link>
      </section>
    </main>
  );
}
