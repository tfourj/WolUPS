import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { CommandLog } from "@/components/CommandLog";
import { Field, SwitchRow } from "@/components/common";
import { CopyField } from "@/components/CopyField";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CommandState, ConfSection, Enrollment, FileChange, NutDetect, NutHost, ScanDevice } from "@/lib/types";
import { matchScanned, scanLabel } from "@/lib/nut-match";
import { ChangePreview, ExistingConfig, hasExistingConfig, type ExistingChoice } from "./NutExistingConfig";
import { NutUpsEditDialog, type EditTarget } from "./NutUpsEditDialog";

export type WizardStep = "install" | "check" | "scan" | "configure" | "apply";

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "install", label: "Install" },
  { id: "check", label: "Check" },
  { id: "scan", label: "Scan" },
  { id: "configure", label: "Configure" },
  { id: "apply", label: "Apply" },
];

type SnmpForm = {
  start: string;
  end: string;
  version: "v1" | "v2c" | "v3";
  community: string;
  secLevel: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  secName: string;
  authProtocol: string;
  authPassword: string;
  privProtocol: string;
  privPassword: string;
};

const EMPTY_SNMP: SnmpForm = {
  start: "",
  end: "",
  version: "v2c",
  community: "public",
  secLevel: "authPriv",
  secName: "",
  authProtocol: "SHA",
  authPassword: "",
  privProtocol: "AES",
  privPassword: "",
};

/** A UPS picked in the scan or import step. */
type Pick = {
  key: string;
  checked: boolean;
  name: string;
  displayName: string;
  section: ConfSection;
  imported: boolean;
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "ups"
  );
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = slug(base);
  for (let i = 2; taken.has(name); i++) name = `${slug(base).slice(0, 29)}-${i}`;
  taken.add(name);
  return name;
}

/** Driver, port and serial of a section, for lists. */
function sectionSummary(section: ConfSection): string {
  const serial = section.extra?.serial;
  return [section.driver, section.port, serial && `serial ${serial}`].filter(Boolean).join(" · ");
}

/** A UPS already in ups.conf, shown in the scan step instead of being offered again. */
type Configured = {
  section: ConfSection;
  displayName: string;
  upsId: string | null;
  managed: boolean;
  found: boolean;
};

/** SNMP passwords from the form, added to SNMP devices on apply. The server never stores them. */
function snmpSecrets(form: SnmpForm): Record<string, string> {
  if (form.version !== "v3") return form.community ? { community: form.community } : {};
  const secrets: Record<string, string> = {};
  if (form.secLevel !== "noAuthNoPriv") secrets.authPassword = form.authPassword;
  if (form.secLevel === "authPriv") secrets.privPassword = form.privPassword;
  return secrets;
}

function StepBar({ step }: { step: WizardStep }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.id} className={cn(i === index && "text-foreground font-medium", i < index && "text-success")}>
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-warning/40 bg-warning/10 text-warning flex gap-2 rounded-md border p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function NutHostWizard({
  open,
  host: initialHost,
  startAt = "install",
  onClose,
}: {
  open: boolean;
  host: NutHost | null;
  startAt?: WizardStep;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [hostId, setHostId] = useState<string | null>(null);
  const [step, setStep] = useState<WizardStep>("install");
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [detect, setDetect] = useState<NutDetect | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [usb, setUsb] = useState(true);
  const [snmpOn, setSnmpOn] = useState(false);
  const [snmp, setSnmp] = useState<SnmpForm>(EMPTY_SNMP);
  const [scanCommand, setScanCommand] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [listen, setListen] = useState("");
  const [localShutdown, setLocalShutdown] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [choice, setChoice] = useState<ExistingChoice>("migrate");
  const [preview, setPreview] = useState<{ changes: FileChange[]; adopt: { name: string }[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  // Reset whenever the wizard opens.
  useEffect(() => {
    if (!open) return;
    setHostId(initialHost?.id ?? null);
    setStep(initialHost?.agent ? startAt : "install");
    setName("");
    setEnrollment(null);
    setDetect(null);
    setInstallCommand(null);
    setInstallError(null);
    setUsb(true);
    setSnmpOn(false);
    setSnmp(EMPTY_SNMP);
    setScanCommand(null);
    setScanError(null);
    setPicks([]);
    setListen(initialHost?.listenAddress ?? "");
    setLocalShutdown(initialHost?.localShutdown ?? false);
    setApplying(false);
    setApplyError(null);
    setApplied(null);
    setChoice("migrate");
    setPreview(null);
    setPreviewError(null);
    setFound([]);
    setEditTarget(null);
  }, [open, initialHost, startAt]);

  const { data: host } = useQuery({
    queryKey: ["nut-hosts", hostId],
    queryFn: () => api.get<NutHost>(`/nut-hosts/${hostId}`),
    enabled: open && !!hostId,
    refetchInterval: 2_000,
  });
  const connected = !!host?.agent?.connected;

  const runDetect = useCallback(async () => {
    if (!hostId) return null;
    setDetecting(true);
    try {
      const result = await api.post<NutDetect>(`/nut-hosts/${hostId}/detect`);
      setDetect(result);
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setDetecting(false);
    }
  }, [hostId]);

  useEffect(() => {
    if (open && (step === "check" || step === "scan") && connected && !detect && !detecting) void runDetect();
  }, [open, step, connected, detect, detecting, runDetect]);

  // Offer the UPS sections already in ups.conf for import. The host refetches every few seconds, so this keys on the
  // monitored names and keeps what the user already picked.
  const monitoredKey = (host?.ups ?? []).map((u) => u.upsName).join(",");
  useEffect(() => {
    if (!detect) return;
    const monitored = new Set(monitoredKey.split(","));
    setPicks((current) => {
      const scanned = current.filter((p) => !p.imported);
      const imported = detect.existing
        .filter((section) => !monitored.has(section.name))
        .map(
          (section) =>
            current.find((p) => p.key === `import:${section.name}`) ?? {
              key: `import:${section.name}`,
              checked: true,
              name: section.name,
              displayName:
                detect.adopt.find((entry) => entry.upsName === section.name)?.name || section.desc || section.name,
              section,
              imported: true,
            },
        );
      return [...imported, ...scanned];
    });
  }, [detect, monitoredKey]);

  // Prefer an address upsd already listens on, else the host's first address.
  useEffect(() => {
    if (listen || !host) return;
    const ips = host.interfaces.flatMap((i) => i.cidrs.map((cidr) => cidr.split("/")[0]));
    const current = detect?.config.listen.find((addr) => ips.includes(addr));
    if (current || ips[0]) setListen(current ?? ips[0]);
  }, [host, listen, detect]);

  const createHost = async () => {
    try {
      const created = await api.post<{ host: NutHost; enrollment: Enrollment }>("/nut-hosts", { name });
      setHostId(created.host.id);
      setEnrollment(created.enrollment);
      queryClient.invalidateQueries({ queryKey: ["nut-hosts"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const newToken = async () => {
    if (!hostId) return;
    setEnrollment(await api.post<Enrollment>(`/nut-hosts/${hostId}/enroll`));
  };

  const startInstall = async () => {
    setInstallError(null);
    try {
      const { commandId } = await api.post<{ commandId: string }>(`/nut-hosts/${hostId}/install`);
      setInstallCommand(commandId);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    }
  };

  const installFinished = useCallback(
    async (state: CommandState) => {
      if (state.status !== "done") {
        setInstallError(state.error ?? "installing NUT failed");
        return;
      }
      // The agent restarts after installing NUT. Detect again once it is back.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const result = await api.post<NutDetect>(`/nut-hosts/${hostId}/detect`).catch(() => null);
        if (result?.nutVersion) {
          setDetect(result);
          setInstallCommand(null);
          return;
        }
      }
      setInstallError("NUT was installed, but the agent did not report back. Check its logs on the host.");
    },
    [hostId],
  );

  const startScan = async () => {
    setScanError(null);
    const body: Record<string, unknown> = { usb };
    if (snmpOn) {
      const { community, secLevel, secName, authProtocol, authPassword, privProtocol, privPassword, ...base } = snmp;
      body.snmp =
        snmp.version === "v3"
          ? {
              ...base,
              secLevel,
              secName,
              ...(secLevel !== "noAuthNoPriv" ? { authProtocol, authPassword } : {}),
              ...(secLevel === "authPriv" ? { privProtocol, privPassword } : {}),
            }
          : { ...base, ...(community ? { community } : {}) };
    }
    try {
      const { commandId } = await api.post<{ commandId: string }>(`/nut-hosts/${hostId}/scan`, body);
      setScanCommand(commandId);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    }
  };

  const scanFinished = useCallback(
    (state: CommandState) => {
      if (state.status !== "done") {
        setScanError(state.error ?? "scan failed");
        return;
      }
      const all = (state.result?.devices as ScanDevice[] | undefined) ?? [];
      // UPS already in ups.conf, recognised by serial, are shown as configured instead of offered again.
      const matches = matchScanned(all, [...(detect?.managed ?? []), ...(detect?.existing ?? [])]);
      setFound([...matches.values()]);
      const devices = all.filter((_, i) => !matches.has(i));
      setPicks((current) => {
        const kept = current.filter((p) => p.imported);
        const taken = new Set([
          ...kept.map((p) => p.name),
          ...(detect?.managed ?? []).map((s) => s.name),
          ...(host?.ups ?? []).map((u) => u.upsName),
        ]);
        const scanned = devices.map((device, i) => ({
          key: `scan:${i}:${device.driver}:${device.port}:${device.serial ?? ""}`,
          checked: devices.length === 1,
          name: uniqueName(device.product || device.vendor || device.driver, taken),
          displayName: scanLabel(device, devices),
          section: { name: "", driver: device.driver, port: device.port, desc: device.desc, extra: device.extra },
          imported: false,
        }));
        return [...kept, ...scanned];
      });
      setScanCommand(null);
    },
    [detect, host?.ups],
  );

  const selected = picks.filter((p) => p.checked);
  const configured = useMemo<Configured[]>(() => {
    if (!detect) return [];
    const rows = host?.ups ?? [];
    const imported = new Set(picks.filter((p) => p.imported).map((p) => p.name));
    const entry = (section: ConfSection, managed: boolean): Configured => {
      const row = rows.find((u) => u.upsName === section.name);
      return {
        section,
        displayName: row?.name ?? (section.desc || section.name),
        upsId: row?.id ?? null,
        managed,
        found: found.includes(section.name),
      };
    };
    return [
      ...detect.managed.map((section) => entry(section, true)),
      // Sections outside the WolUPS block that are not offered for import are already monitored as they are.
      ...detect.existing.filter((section) => !imported.has(section.name)).map((section) => entry(section, false)),
    ];
  }, [detect, host?.ups, picks, found]);
  const listenOptions = useMemo(
    () =>
      (host?.interfaces ?? []).flatMap((iface) =>
        iface.cidrs.map((cidr) => ({ ip: cidr.split("/")[0], label: `${cidr.split("/")[0]} (${iface.name})` })),
      ),
    [host?.interfaces],
  );

  const request = useCallback(() => {
    const secrets = snmpOn ? snmpSecrets(snmp) : {};
    const chosen = picks.filter((p) => p.checked);
    return {
      ups: chosen
          .filter((p) => !p.imported)
          .map((p) => ({
            name: p.name,
            displayName: p.displayName,
            driver: p.section.driver,
            port: p.section.port,
            ...(p.section.desc ? { desc: p.section.desc.replace(/["\\\n]/g, "").slice(0, 100) } : {}),
            extra: { ...p.section.extra, ...(p.section.driver === "snmp-ups" ? secrets : {}) },
          })),
      imported: chosen.filter((p) => p.imported).map((p) => ({ name: p.name, displayName: p.displayName })),
      listen,
      localShutdown,
      migrate: choice === "migrate",
    };
  }, [picks, snmpOn, snmp, listen, localShutdown, choice]);

  // Ask the agent what applying would change whenever the configuration changes.
  useEffect(() => {
    if (step !== "configure" || !hostId || !listen) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    api
      .post<{ changes: FileChange[]; adopt: { name: string }[] }>(`/nut-hosts/${hostId}/preview`, request())
      .then((result) => current && setPreview(result))
      .catch((error) => current && setPreviewError(error instanceof Error ? error.message : String(error)));
    return () => {
      current = false;
    };
  }, [step, hostId, listen, request]);

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await api.post(`/nut-hosts/${hostId}/apply`, request());
      setApplied(selected.map((p) => p.displayName));
      queryClient.invalidateQueries({ queryKey: ["ups"] });
      queryClient.invalidateQueries({ queryKey: ["nut-hosts"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const nutReady = !!detect?.nutVersion;
  const namesValid = selected.every((p) => /^[a-z0-9_-]{1,32}$/.test(p.name) && p.displayName.trim());
  const canNext: Record<WizardStep, boolean> = {
    install: connected,
    check: connected && nutReady,
    scan: selected.length > 0 && namesValid && !scanCommand,
    configure: !!listen && !!preview,
    apply: false,
  };
  const index = STEPS.findIndex((s) => s.id === step);
  const goTo = (next: WizardStep) => {
    if (next === "apply") void apply();
    setStep(next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{host?.name ?? initialHost?.name ?? "Add NUT host"}</DialogTitle>
          <StepBar step={step} />
        </DialogHeader>

        <div className="-mx-1 grid max-h-[65vh] min-w-0 gap-4 overflow-y-auto px-1">
          {step === "install" && (
            <InstallStep
              hostId={hostId}
              name={name}
              setName={setName}
              onCreate={createHost}
              enrollment={enrollment}
              onNewToken={newToken}
              connected={connected}
              version={host?.agent?.version ?? null}
              paired={!!host?.agent}
            />
          )}

          {step === "check" && (
            <div className="grid gap-4">
              {!detect ? (
                <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
              ) : (
                <dl className="grid gap-2">
                  <Row label="System">{detect.os}</Row>
                  <Row label="Package manager">{detect.packageManager || "None found"}</Row>
                  <Row label="NUT">{detect.nutVersion ? `v${detect.nutVersion}` : "Not installed"}</Row>
                  <Row label="Config">{detect.configDir}</Row>
                </dl>
              )}
              {detect?.nutVersion && hasExistingConfig(detect) && (
                <ExistingConfig detect={detect} choice={choice} onChoice={setChoice} />
              )}
              {detect && !detect.nutVersion && !installCommand && (
                <div>
                  <Button onClick={startInstall} disabled={!detect.packageManager}>
                    Install NUT
                  </Button>
                </div>
              )}
              {installCommand && hostId && (
                <CommandLog hostId={hostId} commandId={installCommand} onFinished={installFinished} />
              )}
              {installError && <Warning>{installError}</Warning>}
            </div>
          )}

          {step === "scan" && hostId && (
            <ScanStep
              usb={usb}
              setUsb={setUsb}
              snmpOn={snmpOn}
              setSnmpOn={setSnmpOn}
              snmp={snmp}
              setSnmp={setSnmp}
              scanning={!!scanCommand}
              onScan={startScan}
              log={
                scanCommand ? <CommandLog hostId={hostId} commandId={scanCommand} onFinished={scanFinished} /> : null
              }
              error={scanError}
              picks={picks}
              setPicks={setPicks}
              importLabel={choice === "migrate" ? "moves into WolUPS" : "already in ups.conf"}
              configured={configured}
              onEdit={(item) =>
                setEditTarget({ section: item.section, displayName: item.displayName, upsId: item.upsId })
              }
            />
          )}

          {step === "configure" && (
            <div className="grid gap-4">
              <Field
                label="Listen on"
                help={
                  host?.sameMachine
                    ? "WolUPS runs on this host and connects through 127.0.0.1 on port 3493."
                    : "The WolUPS server connects to this address on port 3493."
                }
              >
                <Select value={listen} onValueChange={setListen}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick an address" />
                  </SelectTrigger>
                  <SelectContent>
                    {listenOptions.map((option) => (
                      <SelectItem key={option.ip} value={option.ip}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <SwitchRow label="Shut down this host" help="upsmon on this host shuts it down when the UPS runs low.">
                <Switch checked={localShutdown} onCheckedChange={setLocalShutdown} />
              </SwitchRow>
              <dl className="grid gap-2">
                <Row label="UPS">{selected.map((p) => `${p.displayName} (${p.name})`).join(", ")}</Row>
                {preview && preview.adopt.length > 0 && (
                  <Row label="Takes over">{preview.adopt.map((entry) => entry.name).join(", ")}</Row>
                )}
              </dl>
              {previewError && <Warning>{previewError}</Warning>}
              {!preview && !previewError && <Loader2 className="text-muted-foreground mx-auto size-5 animate-spin" />}
              {preview && <ChangePreview changes={preview.changes} />}
            </div>
          )}

          {step === "apply" && (
            <div className="grid gap-3">
              {applying && (
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Writing the config and checking that WolUPS can read each UPS...
                </div>
              )}
              {applyError && <Warning>{applyError}</Warning>}
              {applied && (
                <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
                  <CheckCircle2 className="text-success size-4" />
                  Added {applied.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {step !== "install" && !applied && (
            <Button
              variant="outline"
              onClick={() => setStep(STEPS[index - 1].id)}
              disabled={applying || !!installCommand || !!scanCommand}
            >
              Back
            </Button>
          )}
          {step === "apply" ? (
            <Button onClick={onClose} disabled={applying}>
              {applied ? "Done" : "Close"}
            </Button>
          ) : (
            <Button onClick={() => goTo(STEPS[index + 1].id)} disabled={!canNext[step]}>
              {step === "configure" ? "Apply" : "Next"}
            </Button>
          )}
        </DialogFooter>
        <NutUpsEditDialog
          host={host ?? null}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setDetect(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function InstallStep({
  hostId,
  name,
  setName,
  onCreate,
  enrollment,
  onNewToken,
  connected,
  version,
  paired,
}: {
  hostId: string | null;
  name: string;
  setName: (name: string) => void;
  onCreate: () => void;
  enrollment: Enrollment | null;
  onNewToken: () => void;
  connected: boolean;
  version: string | null;
  paired: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (!hostId) {
    return (
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate();
        }}
      >
        <Field label="Name" htmlFor="nut-host-name">
          <Input id="nut-host-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="pi" autoFocus />
        </Field>
        <div>
          <Button type="submit" disabled={!name.trim()}>
            Create install command
          </Button>
        </div>
      </form>
    );
  }
  if (!enrollment) {
    return (
      <div>
        <Button variant="outline" onClick={onNewToken}>
          Show install command
        </Button>
      </div>
    );
  }
  const left = Math.max(0, Math.floor((new Date(enrollment.expiresAt).getTime() - now) / 1000));
  return (
    <div className="grid gap-4">
      <p className="text-sm">Run this as root on the machine the UPS is connected to:</p>
      {enrollment.insecure && (
        <Warning>BASE_URL uses http, so the token travels unencrypted. Use https outside a trusted LAN.</Warning>
      )}
      <CopyField value={enrollment.command} />
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {left === 0
            ? "Token expired"
            : `One-time token, expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
        </span>
        {left === 0 && (
          <Button size="sm" variant="outline" onClick={onNewToken}>
            New token
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
        {connected ? (
          <>
            <CheckCircle2 className="text-success size-4" />
            NUT agent v{version} paired and connected
          </>
        ) : (
          <>
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
            {paired ? "Paired, waiting for the agent to connect..." : "Waiting for the agent to pair..."}
          </>
        )}
      </div>
    </div>
  );
}

function ScanStep({
  usb,
  setUsb,
  snmpOn,
  setSnmpOn,
  snmp,
  setSnmp,
  scanning,
  onScan,
  log,
  error,
  picks,
  setPicks,
  importLabel,
  configured,
  onEdit,
}: {
  usb: boolean;
  setUsb: (value: boolean) => void;
  snmpOn: boolean;
  setSnmpOn: (value: boolean) => void;
  snmp: SnmpForm;
  setSnmp: (value: SnmpForm) => void;
  scanning: boolean;
  onScan: () => void;
  log: React.ReactNode;
  error: string | null;
  picks: Pick[];
  setPicks: (update: (current: Pick[]) => Pick[]) => void;
  importLabel: string;
  configured: Configured[];
  onEdit: (item: Configured) => void;
}) {
  const set = (patch: Partial<SnmpForm>) => setSnmp({ ...snmp, ...patch });
  const update = (key: string, patch: Partial<Pick>) =>
    setPicks((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const v3 = snmp.version === "v3";

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={usb} onCheckedChange={(v) => setUsb(v === true)} />
          USB
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={snmpOn} onCheckedChange={(v) => setSnmpOn(v === true)} />
          SNMP
        </label>
        {snmpOn && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field label="From" htmlFor="snmp-start">
              <Input id="snmp-start" value={snmp.start} onChange={(e) => set({ start: e.target.value })} />
            </Field>
            <Field label="To" htmlFor="snmp-end">
              <Input id="snmp-end" value={snmp.end} onChange={(e) => set({ end: e.target.value })} />
            </Field>
            <Field label="Version">
              <Select value={snmp.version} onValueChange={(v) => set({ version: v as SnmpForm["version"] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="v1">v1</SelectItem>
                  <SelectItem value="v2c">v2c</SelectItem>
                  <SelectItem value="v3">v3</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {!v3 ? (
              <Field label="Community" htmlFor="snmp-community">
                <Input
                  id="snmp-community"
                  value={snmp.community}
                  onChange={(e) => set({ community: e.target.value })}
                />
              </Field>
            ) : (
              <>
                <Field label="Security level">
                  <Select value={snmp.secLevel} onValueChange={(v) => set({ secLevel: v as SnmpForm["secLevel"] })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="noAuthNoPriv">No authentication</SelectItem>
                      <SelectItem value="authNoPriv">Authentication</SelectItem>
                      <SelectItem value="authPriv">Authentication and privacy</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="User" htmlFor="snmp-user">
                  <Input id="snmp-user" value={snmp.secName} onChange={(e) => set({ secName: e.target.value })} />
                </Field>
                {snmp.secLevel !== "noAuthNoPriv" && (
                  <>
                    <Field label="Auth protocol">
                      <Select value={snmp.authProtocol} onValueChange={(v) => set({ authProtocol: v })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["MD5", "SHA", "SHA256", "SHA384", "SHA512"].map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Auth password" htmlFor="snmp-auth">
                      <Input
                        id="snmp-auth"
                        type="password"
                        autoComplete="off"
                        value={snmp.authPassword}
                        onChange={(e) => set({ authPassword: e.target.value })}
                      />
                    </Field>
                  </>
                )}
                {snmp.secLevel === "authPriv" && (
                  <>
                    <Field label="Privacy protocol">
                      <Select value={snmp.privProtocol} onValueChange={(v) => set({ privProtocol: v })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["DES", "AES", "AES192", "AES256"].map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Privacy password" htmlFor="snmp-priv">
                      <Input
                        id="snmp-priv"
                        type="password"
                        autoComplete="off"
                        value={snmp.privPassword}
                        onChange={(e) => set({ privPassword: e.target.value })}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
          </div>
        )}
        <div>
          <Button variant="outline" onClick={onScan} disabled={scanning || (!usb && !snmpOn)}>
            {scanning && <Loader2 className="animate-spin" />}
            Scan
          </Button>
        </div>
      </div>

      {log}
      {error && <Warning>{error}</Warning>}

      {configured.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Already set up</p>
          {configured.map((item) => (
            <div key={item.section.name} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {item.displayName}
                  {item.found && <span className="text-success font-normal"> · found</span>}
                </p>
                <p className="text-muted-foreground truncate text-xs">{sectionSummary(item.section)}</p>
              </div>
              {item.managed && (
                <Button size="sm" variant="outline" onClick={() => onEdit(item)}>
                  <Pencil />
                  Edit
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {picks.length > 0 && (
        <div className="grid gap-2">
          {picks.map((p) => (
            <div key={p.key} className="grid gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={p.checked} onCheckedChange={(v) => update(p.key, { checked: v === true })} />
                {p.displayName}
                <span className="text-muted-foreground font-normal">
                  {p.imported ? importLabel : sectionSummary(p.section)}
                </span>
              </label>
              {p.checked && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Display name">
                    <Input value={p.displayName} onChange={(e) => update(p.key, { displayName: e.target.value })} />
                  </Field>
                  <Field label="NUT name">
                    <Input
                      value={p.name}
                      disabled={p.imported}
                      onChange={(e) => update(p.key, { name: e.target.value.toLowerCase() })}
                      aria-invalid={!/^[a-z0-9_-]{1,32}$/.test(p.name)}
                    />
                  </Field>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
