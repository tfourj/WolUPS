const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive name order: "pve-2" before "pve-10", "alpha" before "Zeta". */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}
