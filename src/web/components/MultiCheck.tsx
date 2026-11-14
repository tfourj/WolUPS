import { Checkbox } from "@/components/ui/checkbox";

/** Checkbox list. An empty selection means "all" when `allLabel` is given. */
export function MultiCheck({
  options,
  value,
  onChange,
  columns = 2,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  columns?: 1 | 2;
}) {
  const toggle = (v: string, on: boolean) => onChange(on ? [...value, v] : value.filter((x) => x !== v));
  return (
    <div className={columns === 2 ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={value.includes(o.value)} onCheckedChange={(c) => toggle(o.value, c === true)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}
