"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Member = { user_id: string; full_name: string | null; email: string; account_role: string; status: string; created_at: string };
type Customer = { id: string; name: string; status: string; plan_tier: string; max_users: number; created_at: string; status_changed_at: string; suspension_reason: string | null; details: { contact_name: string | null; contact_email: string | null; contact_phone: string | null; internal_notes: string | null } | null; commercial: { renewal_date: string | null } | null };

export function PlatformCustomerDetail({ id }: { id: string }) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<Array<{ id: number; actor_user_id: string | null; action: string; details: Record<string, unknown>; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/platform/customers/${id}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load customer");
      setCustomer(result.customer); setMembers(result.members); setEvents(result.events); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load customer"); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function send(path: string, body: Record<string, unknown>, method = "PATCH") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Customer update failed");
      setNotice("Changes saved."); await load(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Customer update failed"); return false; }
    finally { setBusy(false); }
  }

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    await send(`/api/platform/customers/${id}`, data);
  }

  if (loading) return <p className="py-12 text-center text-sm text-muted-foreground">Loading customer…</p>;
  if (!customer) return <div className="space-y-4"><p role="alert">{error || "Customer not found"}</p><Button render={<Link href="/platform/customers" />} variant="outline">Back to customers</Button></div>;

  return <section className="space-y-6">
    <Link className="text-sm text-muted-foreground hover:text-foreground" href="/platform/customers">← Customers</Link>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">{customer.name}</h1><p className="mt-1 text-sm text-muted-foreground">Created {new Date(customer.created_at).toLocaleDateString()} · <span className="capitalize">{customer.status}</span></p></div><div className="flex gap-2">{customer.status === "active" ? <><Button variant="outline" disabled={busy} onClick={() => void send(`/api/platform/customers/${id}/resume-work`, {})}>Resume automations and flows</Button><Button variant="destructive" disabled={busy} onClick={() => { const reason = window.prompt("Reason for suspending this customer account?"); if (reason !== null) void send(`/api/platform/customers/${id}/status`, { status: "suspended", reason }); }}>Suspend account</Button></> : <Button disabled={busy || (customer.status === "pending" && !members.some((member) => member.account_role === "owner" && member.status === "active"))} onClick={() => void send(`/api/platform/customers/${id}/status`, { status: "active" })}>{customer.status === "pending" ? "Activate account" : "Reactivate account"}</Button>}</div></div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>}{notice && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{notice}</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      <form onSubmit={saveDetails} className="space-y-4 rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold">Customer details</h2>
        <Field name="name" label="Business/customer name" defaultValue={customer.name} required />
        <Field name="contactName" label="Contact name" defaultValue={customer.details?.contact_name ?? ""} />
        <div className="grid gap-4 sm:grid-cols-2"><Field name="contactEmail" label="Contact email" type="email" defaultValue={customer.details?.contact_email ?? ""} /><Field name="contactPhone" label="Contact phone" defaultValue={customer.details?.contact_phone ?? ""} /></div>
        <Field name="renewalDate" label="Renewal date (manual, informational)" type="date" defaultValue={customer.commercial?.renewal_date ?? ""} />
        <div><Label htmlFor="notes">Internal notes</Label><textarea id="notes" name="notes" rows={4} defaultValue={customer.details?.internal_notes ?? ""} className="mt-1 w-full rounded-md border border-input bg-background p-3 text-sm" /></div>
        <Button type="submit" disabled={busy}>Save customer details</Button>
      </form>

      <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void send(`/api/platform/customers/${id}/entitlements`, { plan: data.get("plan"), seats: Number(data.get("seats")) }); }} className="space-y-4 rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold">Plan and seats</h2>
        <div><Label htmlFor="plan">Selected plan</Label><select id="plan" name="plan" defaultValue={customer.plan_tier} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="starter">Starter</option><option value="team">Team</option></select></div>
        <Field name="seats" label="Allowed active users" type="number" defaultValue={String(customer.max_users)} min="1" required />
        <p className="text-sm text-muted-foreground">Active users: {members.filter((member) => member.status === "active").length}. Starter requires exactly one seat.</p>
        <Button type="submit" disabled={busy}>Save plan and seats</Button>
      </form>

      <MemberSection customerId={id} members={members} canCreateOwner={customer.status === "pending" && !members.some((member) => member.account_role === "owner")} busy={busy} onSave={send} onRefresh={load} />
      <section className="rounded-lg border border-border bg-card p-5"><h2 className="font-semibold">Account status</h2><p className="mt-2 text-sm capitalize">{customer.status}</p>{customer.suspension_reason && <p className="mt-1 text-sm text-muted-foreground">Reason: {customer.suspension_reason}</p>}<p className="mt-1 text-xs text-muted-foreground">Last changed {new Date(customer.status_changed_at).toLocaleString()}</p><p className="mt-3 text-sm text-muted-foreground">Suspension blocks sign-in, CRM APIs, API keys, and outbound work. Customer data is retained. After reactivation, resume automations and flows here; paused broadcasts require an explicit campaign resume by a customer admin.</p></section>

      <section className="rounded-lg border border-border bg-card p-5 xl:col-span-2"><h2 className="font-semibold">Recent activity</h2>{events.length ? <ul className="mt-3 divide-y divide-border">{events.map((event) => <li key={event.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{event.action.replaceAll(".", " ")}</span><span className="text-muted-foreground">{new Date(event.created_at).toLocaleString()}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No recorded activity yet.</p>}</section>
    </div>
  </section>;
}

function MemberSection({ customerId, members, canCreateOwner, busy, onSave, onRefresh }: { customerId: string; members: Member[]; canCreateOwner: boolean; busy: boolean; onSave: (path: string, body: Record<string, unknown>, method?: string) => Promise<boolean>; onRefresh: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAdding(true);
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const ok = await onSave(`/api/platform/customers/${customerId}/members`, data, "POST");
    if (ok) form.reset();
    setAdding(false);
  }
  return <section className="space-y-4 rounded-lg border border-border bg-card p-5 xl:col-span-2"><div><h2 className="font-semibold">Customer users</h2><p className="text-sm text-muted-foreground">{members.filter((member) => member.status === "active").length} active of {members.length} provisioned</p></div>
    <form onSubmit={addMember} className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2 lg:grid-cols-5"><Field name="fullName" label="Full name" required /><Field name="email" label="Email" type="email" required /><Field name="password" label="Initial password" type="password" min="8" required /><div><Label htmlFor="new-role">Role</Label><select id="new-role" name="role" defaultValue={canCreateOwner ? "owner" : "admin"} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm">{canCreateOwner && <option value="owner">Owner</option>}<option value="admin">Admin</option><option value="agent">Agent</option><option value="viewer">Viewer</option></select></div><div className="flex items-end"><Button type="submit" disabled={adding || busy}>{adding ? "Creating…" : "Create user"}</Button></div></form>
    <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="border-b border-border text-muted-foreground"><tr><th className="py-2">Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead><tbody className="divide-y divide-border">{members.map((member) => <tr key={member.user_id}><td className="py-3">{member.full_name || "—"}</td><td>{member.email}</td><td><select aria-label={`Role for ${member.email}`} disabled={busy || member.account_role === "owner"} value={member.account_role} onChange={(event) => { void onSave(`/api/platform/customers/${customerId}/members/${member.user_id}`, { role: event.target.value }); }} className="h-8 rounded-md border border-input bg-background px-2 text-sm">{member.account_role === "owner" && <option value="owner">Owner</option>}<option value="admin">Admin</option><option value="agent">Agent</option><option value="viewer">Viewer</option></select></td><td className="capitalize">{member.status}</td><td className="text-right">{member.account_role !== "owner" && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void onSave(`/api/platform/customers/${customerId}/members/${member.user_id}`, { status: member.status === "active" ? "disabled" : "active" }).then((ok) => { if (ok) void onRefresh(); }); }}>{member.status === "active" ? "Disable" : "Reactivate"}</Button>}</td></tr>)}</tbody></table></div>
  </section>;
}

function Field(props: { name: string; label: string; type?: string; required?: boolean; defaultValue?: string; min?: string }) {
  const id = `customer-${props.name}`;
  return <div className="space-y-1"><Label htmlFor={id}>{props.label}</Label><Input id={id} name={props.name} type={props.type ?? "text"} defaultValue={props.defaultValue} required={props.required} min={props.min} className="bg-background" /></div>;
}
