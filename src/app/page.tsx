import { headers } from "next/headers";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import DashboardContent from "@/components/DashboardContent";

export default async function Home() {
  const h = await headers();
  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const hostname = rawHost.split(":")[0]?.toLowerCase() ?? "";
  const showClearDatabase =
    hostname === "localhost" || hostname === "127.0.0.1";

  return (
    <>
      <Sidebar />
      <main className="ml-[280px] min-h-screen">
        <Topbar showClearDatabase={showClearDatabase} />
        <DashboardContent />
      </main>
    </>
  );
}
