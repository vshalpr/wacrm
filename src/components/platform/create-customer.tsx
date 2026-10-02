"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const inputClass = "bg-background";

export function PlatformCreateCustomer() {
  const router = useRouter();
  const [plan, setPlan] = useState("starter");
  const [seats, setSeats] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.plan = plan; body.seats = seats;
    try {
      const response = await fetch("/api/platform/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (result.customerId) { router.push(`/platform/customers/${result.customerId}`); return; }
      if (!response.ok) throw new Error(result.error || "Customer creation failed");
      router.push(`/platform/customers/${result.customerId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Customer creation failed"); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="max-w-3xl space-y-7 rounded-lg border border-border bg-card p-6">
    <section className="space-y-4"><h2 className="font-medium">Customer account</h2>
      <Field name="name" label="Business/customer name" required />
      <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="plan">Plan</Label><select id="plan" value={plan} onChange={(event) => { setPlan(event.target.value); if (event.target.value === "starter") setSeats("1"); }} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="starter">Starter · 1 user</option><option value="team">Team · configurable seats</option></select></div><Field name="seats" label="Allowed users/seats" type="number" value={seats} onChange={(event) => setSeats(event.target.value)} required min="1" disabled={plan === "starter"} /></div>
    </section>
    <section className="space-y-4"><h2 className="font-medium">Customer contact</h2><Field name="contactName" label="Contact name" /><div className="grid gap-4 sm:grid-cols-2"><Field name="contactEmail" label="Contact email" type="email" /><Field name="contactPhone" label="Contact phone" /></div></section>
    <section className="space-y-4"><h2 className="font-medium">Initial customer administrator</h2><Field name="ownerName" label="Full name" required /><Field name="ownerEmail" label="Email address" type="email" required /><Field name="ownerPassword" label="Initial password" type="password" required min="8" autoComplete="new-password" /></section>
    <section className="space-y-4"><h2 className="font-medium">Internal</h2><Field name="renewalDate" label="Renewal date (optional)" type="date" /><div><Label htmlFor="notes">Internal notes</Label><textarea id="notes" name="notes" rows={4} className="mt-1 w-full rounded-md border border-input bg-background p-3 text-sm" /></div></section>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>}
    <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create customer"}</Button>
  </form>;
}

function Field(props: { name: string; label: string; type?: string; required?: boolean; value?: string; onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void; min?: string; disabled?: boolean; autoComplete?: string }) {
  const id = `customer-${props.name}`;
  return <div className="space-y-1"><Label htmlFor={id}>{props.label}</Label><Input id={id} name={props.name} type={props.type ?? "text"} value={props.value} onChange={props.onChange} required={props.required} min={props.min} disabled={props.disabled} autoComplete={props.autoComplete} className={inputClass} /></div>;
}
