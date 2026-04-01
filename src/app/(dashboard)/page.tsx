import DashboardContent from "@/components/DashboardContent";
import HoursTaughtChart from "@/components/HoursTaughtChart";
import { Suspense } from "react";

export default function Home() {
  return (
    <DashboardContent
      hoursTaughtChart={
        <Suspense fallback={
          <div className="bg-surface-container-low rounded-[1rem] p-6 lg:p-8 flex items-center justify-center border border-outline-variant/10 shadow-sm w-full min-h-[360px] animate-pulse">
            <span className="text-on-surface-variant font-medium">Loading statistics...</span>
          </div>
        }>
          <HoursTaughtChart />
        </Suspense>
      }
    />
  );
}
