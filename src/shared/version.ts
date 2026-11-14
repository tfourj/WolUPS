/** Parse a stable x.y.z version, with or without a leading "v". */
export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((value ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a newer stable version than `current`. Unparseable versions are never newer. */
export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
