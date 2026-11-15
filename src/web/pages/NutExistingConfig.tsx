import { cn } from "@/lib/utils";
import { lineDiff, withContext } from "@/lib/diff";
import type { FileChange, NutDetect } from "@/lib/types";

export type ExistingChoice = "migrate" | "keep";

/** Whether the host already has a NUT setup WolUPS did not write. */
export function hasExistingConfig(detect: NutDetect | null): boolean {
  if (!detect) return false;
  const { config } = detect;
  return [detect.existing, config.listen, config.users, config.monitors].some((list) => list.length > 0);
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ChoiceButton({
  active,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border p-3 text-left text-sm transition-colors",
        active ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      )}
    >
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground text-xs">{detail}</p>
    </button>
  );
}

/** The NUT setup found on the host, and the choice to migrate it into WolUPS or keep it as it is. */
export function ExistingConfig({
  detect,
  choice,
  onChoice,
}: {
  detect: NutDetect;
  choice: ExistingChoice;
  onChoice: (choice: ExistingChoice) => void;
}) {
  const { config } = detect;
  const adopted = new Map(detect.adopt.map((entry) => [entry.upsName, entry]));
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Existing NUT config</p>
      <dl className="grid gap-1.5">
        <Line label="UPS">
          {detect.existing.length === 0 ? (
            "None"
          ) : (
            <ul>
              {detect.existing.map((section) => (
                <li key={section.name}>
                  <span className="font-mono text-xs">[{section.name}]</span> {section.driver} · {section.port}
                  {section.desc ? ` · ${section.desc}` : ""}
                  {adopted.has(section.name) && (
                    <span className="text-muted-foreground"> · in WolUPS as {adopted.get(section.name)!.name}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Line>
        <Line label="Listens on">{config.listen.length ? config.listen.join(", ") : "localhost only"}</Line>
        {config.users.length > 0 && <Line label="Users">{config.users.join(", ")}</Line>}
        {config.monitors.length > 0 && <Line label="upsmon">{config.monitors.join(", ")}</Line>}
        {config.mode && <Line label="Mode">{config.mode}</Line>}
      </dl>
      {detect.existing.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceButton
            active={choice === "migrate"}
            title="Migrate to WolUPS"
            detail="Moves these UPS into the WolUPS section of ups.conf, as written, so WolUPS can manage them."
            onClick={() => onChoice("migrate")}
          />
          <ChoiceButton
            active={choice === "keep"}
            title="Keep my config"
            detail="WolUPS monitors these UPS and leaves their config as it is."
            onClick={() => onChoice("keep")}
          />
        </div>
      )}
    </div>
  );
}

/** Each file applying would change, as a line diff with a little context. Passwords arrive masked. */
export function ChangePreview({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) return <p className="text-muted-foreground text-sm">No file changes</p>;
  return (
    <div className="grid gap-2">
      {changes.map((change) => (
        <details key={change.path} className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 font-mono text-xs">
            {change.before ? change.path : `${change.path} (new)`}
          </summary>
          <div className="bg-muted/50 max-h-64 overflow-auto border-t p-2 font-mono text-xs">
            {withContext(lineDiff(change.before, change.after)).map((line, i) =>
              line === null ? (
                <div key={i} className="text-muted-foreground">
                  ⋯
                </div>
              ) : (
                <div
                  key={i}
                  className={cn(
                    "break-all whitespace-pre-wrap",
                    line.kind === "add" && "text-success",
                    line.kind === "remove" && "text-destructive line-through decoration-1",
                    line.kind === "same" && "text-muted-foreground",
                  )}
                >
                  {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                  {line.text}
                </div>
              ),
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
