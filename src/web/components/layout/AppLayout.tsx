import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router";
import {
  Activity,
  BatteryCharging,
  Bell,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Server,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
import { DEFAULT_TIME_PREFERENCES } from "@shared/time";
import { GitHubIcon } from "@/components/GitHubIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { setTimePreferences } from "@/lib/format";
import { useTheme, type Theme } from "@/lib/theme";
import type { AppSettings, SystemInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/ups", label: "UPS", icon: BatteryCharging },
  { to: "/devices", label: "Devices", icon: Server },
  { to: "/events", label: "Events", icon: Activity },
  { to: "/channels", label: "Channels", icon: Bell },
  { to: "/settings", label: "Settings", icon: Settings },
];

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg">
        <Zap className="size-4" />
      </div>
      <span className="text-lg font-semibold tracking-tight">WolUPS</span>
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="grid gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

const REPO_URL = "https://github.com/tfourj/WolUPS";

type Health = { version: string; commit: string | null };

function RepoLink() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<Health>("/health"),
    staleTime: Infinity,
  });
  const linkClass =
    "rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors " +
    "hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
  const versionUrl = data?.commit ? `${REPO_URL}/commit/${data.commit}` : `${REPO_URL}/releases/tag/v${data?.version}`;
  return (
    <div className="flex items-center justify-between gap-2">
      <a href={REPO_URL} target="_blank" rel="noreferrer" className={cn(linkClass, "flex items-center gap-2 px-3")}>
        <GitHubIcon className="size-4" />
        tfourj/WolUPS
      </a>
      {data && (
        <a
          href={versionUrl}
          target="_blank"
          rel="noreferrer"
          title={data.commit ? "View commit" : "View release"}
          className={cn("font-mono tabular-nums", linkClass)}
        >
          {data.commit ?? `v${data.version}`}
        </a>
      )}
    </div>
  );
}

function UserMenu() {
  const { data } = authClient.useSession();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const name = data?.user.name ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-2">
          <div className="bg-muted grid size-8 place-items-center rounded-full text-sm font-semibold uppercase">
            {name.slice(0, 1) || "?"}
          </div>
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-muted-foreground truncate text-xs">{data?.user.email}</p>
          </div>
          <ThemeIcon className="text-muted-foreground size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            await authClient.signOut();
            navigate("/login");
          }}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings; system: SystemInfo }>("/settings"),
  });
  const time = settings?.settings.time ?? DEFAULT_TIME_PREFERENCES;
  setTimePreferences(time, settings?.system.timezone);
  // Formatters read the time display when they run, so pages are remounted to pick up a change.
  const timeKey = `${time.timezone}|${time.timeFormat}|${time.timeStyle}`;
  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar border-sidebar-border sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r p-3 md:flex">
        <div className="py-2">
          <Brand />
        </div>
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <div className="pb-2">
          <RepoLink />
        </div>
        <UserMenu />
      </aside>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="bg-sidebar flex w-64 flex-col p-3">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="py-2">
            <Brand />
          </div>
          <div className="mt-6 flex-1">
            <NavItems onNavigate={() => setOpen(false)} />
          </div>
          <div className="pb-2">
            <RepoLink />
          </div>
          <UserMenu />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu className="size-5" />
          </Button>
          <Brand />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 md:p-8">
          <Outlet key={timeKey} />
        </main>
      </div>
    </div>
  );
}
