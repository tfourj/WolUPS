import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { CopyField } from "@/components/CopyField";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Device } from "@/lib/types";

type Enrollment = {
  token: string;
  expiresAt: string;
  serverUrl: string;
  insecure: boolean;
  command: string;
  uninstallCommand: string;
};

function useCountdown(until: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return left;
}

export function InstallAgentDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const queryClient = useQueryClient();
  const previousEnrolledAt = device?.agent?.enrolledAt ?? null;

  useEffect(() => {
    setEnrollment(null);
    if (!device) return;
    api
      .post<Enrollment>(`/devices/${device.id}/enroll`)
      .then(setEnrollment)
      .catch((e) => toast.error(e.message));
  }, [device]);

  // Poll until the agent pairs and connects.
  const { data: live } = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<Device[]>("/devices"),
    refetchInterval: 2_000,
    enabled: !!device,
    select: (list) => list.find((d) => d.id === device?.id),
  });
  const paired = !!live?.agent && live.agent.enrolledAt !== previousEnrolledAt;
  const connected = paired && live?.agent?.connected;

  useEffect(() => {
    if (connected) queryClient.invalidateQueries({ queryKey: ["overview"] });
  }, [connected, queryClient]);

  const left = useCountdown(enrollment?.expiresAt);
  const expired = left === 0;

  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{device?.agent ? "Reinstall agent" : "Install agent"} on {device?.name}</DialogTitle>
          <DialogDescription>
            Run this on the device as root. On Proxmox you are root already; elsewhere put sudo before sh.
          </DialogDescription>
        </DialogHeader>

        {!enrollment ? (
          <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
        ) : (
          <div className="grid gap-4">
            {enrollment.insecure && (
              <div className="border-warning/40 bg-warning/10 text-warning flex gap-2 rounded-md border p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                BASE_URL uses http, so the token travels unencrypted. Use https outside a trusted LAN.
              </div>
            )}
            <CopyField value={enrollment.command} />
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>
                {expired
                  ? "Token expired"
                  : `One-time token, expires in ${Math.floor((left ?? 0) / 60)}:${String((left ?? 0) % 60).padStart(2, "0")}`}
              </span>
              {expired && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => api.post<Enrollment>(`/devices/${device!.id}/enroll`).then(setEnrollment)}
                >
                  New token
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
              {connected ? (
                <>
                  <CheckCircle2 className="text-success size-4" />
                  Agent v{live?.agent?.version} paired and connected
                </>
              ) : paired ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Paired, waiting for the agent to connect...
                </>
              ) : (
                <>
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                  Waiting for the agent to pair...
                </>
              )}
            </div>

            <details className="text-sm">
              <summary className="text-muted-foreground cursor-pointer">Uninstall command</summary>
              <div className="mt-2">
                <CopyField value={enrollment.uninstallCommand} />
              </div>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
