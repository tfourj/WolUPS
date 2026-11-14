import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { authClient } from "@/lib/auth-client";
import { ChannelsPage } from "@/pages/ChannelsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { EventsPage } from "@/pages/EventsPage";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupPage } from "@/pages/SetupPage";
import { UpsPage } from "@/pages/UpsPage";

function FullScreenSpinner() {
  return (
    <div className="grid min-h-svh place-items-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" />
    </div>
  );
}

export function App() {
  const location = useLocation();
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: async () => (await fetch("/api/setup")).json() as Promise<{ needsSetup: boolean }>,
    staleTime: Infinity,
  });
  const session = authClient.useSession();
  // Sign-in refetches the session. Only wait for the first load, so the login page keeps its two-factor step.
  const sessionLoaded = useRef(false);
  if (!session.isPending) sessionLoaded.current = true;

  if (setup.isPending || !sessionLoaded.current) return <FullScreenSpinner />;

  const needsSetup = setup.data?.needsSetup ?? false;
  const signedIn = !!session.data;

  // No account yet: every route goes to /register. Afterwards /register is closed.
  if (needsSetup && location.pathname !== "/register") return <Navigate to="/register" replace />;
  if (!needsSetup && location.pathname === "/register") return <Navigate to="/login" replace />;

  return (
    <Routes>
      <Route path="/register" element={<SetupPage />} />
      <Route path="/login" element={signedIn ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={signedIn ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<DashboardPage />} />
        <Route path="ups" element={<UpsPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
