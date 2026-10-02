import { PlatformCustomerDetail } from "@/components/platform/customer-detail";

export default async function PlatformCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlatformCustomerDetail id={id} />;
}
