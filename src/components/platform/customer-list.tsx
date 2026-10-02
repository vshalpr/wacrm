"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Customer = {
  id: string; name: string; status: string; plan_tier: string; max_users: number;
  active_users: number; created_at: string;
  details: { contact_name: string | null; contact_email: string | null } | null;
};

export function PlatformCustomerList() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [plan, setPlan] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams();
    if (search.trim()) query.set("search", search.trim());
    if (status !== "all") query.set("status", status);
    if (plan !== "all") query.set("plan", plan);
    query.set("page", String(page));
    try {
      const response = await fetch(`/api/platform/customers?${query}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load customers");
      setCustomers(result.customers);
      setTotal(result.total ?? 0);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load customers");
    } finally { setLoading(false); }
  }, [search, status, plan, page]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-2xl font-semibold">Customers</h1><p className="mt-1 text-sm text-muted-foreground">Manage customer accounts, plans, and access.</p></div>
        <Button render={<Link href="/platform/customers/new" />}>Create customer</Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Input value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search customer name" className="max-w-sm" />
        <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
          <option value="all">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option>
        </select>
        <select value={plan} onChange={(event) => { setPage(1); setPlan(event.target.value); }} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
          <option value="all">All plans</option><option value="starter">Starter</option><option value="team">Team</option>
        </select>
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-muted-foreground"><tr>{["Customer", "Contact", "Plan", "Users", "Status", "Created"].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">
            {customers.map((customer) => <tr key={customer.id} className="hover:bg-muted/40">
              <td className="px-4 py-3"><Link className="font-medium text-primary hover:underline" href={`/platform/customers/${customer.id}`}>{customer.name}</Link></td>
              <td className="px-4 py-3">{customer.details?.contact_name ?? "—"}<div className="text-xs text-muted-foreground">{customer.details?.contact_email ?? ""}</div></td>
              <td className="px-4 py-3">{customer.plan_tier}</td><td className="px-4 py-3">{customer.active_users} / {customer.max_users}</td>
              <td className="px-4 py-3 capitalize">{customer.status}</td><td className="px-4 py-3">{new Date(customer.created_at).toLocaleDateString()}</td>
            </tr>)}
            {!loading && customers.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No customers found.</td></tr>}
            {loading && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">Loading customers…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{total ? `${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total} customers` : "0 customers"}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={loading || page * 25 >= total} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
    </section>
  );
}
