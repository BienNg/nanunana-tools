import { headers } from "next/headers";
import DashboardShell from "@/components/DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const hostname = rawHost.split(":")[0]?.toLowerCase() ?? "";
  const showClearDatabase =
    hostname === "localhost" || hostname === "127.0.0.1";

  return (
    <DashboardShell showClearDatabase={showClearDatabase}>
      {children}
    </DashboardShell>
  );
}
