"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (password.length < 8) { setError("Use a password with at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) { setError(updateError.message); setBusy(false); return; }
    await supabase.auth.signOut();
    router.replace("/login?passwordReset=1");
    router.refresh();
  }

  return <div className="flex min-h-screen items-center justify-center bg-background px-4"><Card className="w-full max-w-md"><CardHeader><CardTitle>Set a new password</CardTitle><CardDescription>Choose a new password for your ReliCRM account.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-4">
    <div className="space-y-2"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
    <div className="space-y-2"><Label htmlFor="confirm-password">Confirm password</Label><Input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={busy} className="w-full">{busy ? "Saving…" : "Save password"}</Button>
    <p className="text-center text-sm text-muted-foreground"><Link href="/login" className="text-primary hover:underline">Return to sign in</Link></p>
  </form></CardContent></Card></div>;
}
