import Link from "next/link";
import { PlatformCreateCustomer } from "@/components/platform/create-customer";

export default function NewPlatformCustomerPage() {
  return (
    <div className="space-y-6">
      <Link className="text-sm text-muted-foreground hover:text-foreground" href="/platform/customers">← Customers</Link>
      <div><h1 className="text-2xl font-semibold">Create customer</h1><p className="mt-1 text-sm text-muted-foreground">Set the customer plan and provision the first customer administrator.</p></div>
      <PlatformCreateCustomer />
    </div>
  );
}
