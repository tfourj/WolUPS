import type { ConfSection, ScanDevice } from "./types";

const norm = (value: string | undefined) => (value ?? "").trim().toLowerCase();

function ids(item: { vendorid?: string; productid?: string }) {
  return item.vendorid && item.productid ? `${norm(item.vendorid)}:${norm(item.productid)}` : "";
}

function deviceIds(device: ScanDevice) {
  return ids({
    vendorid: device.vendorid ?? device.extra?.vendorid,
    productid: device.productid ?? device.extra?.productid,
  });
}

/**
 * Which scanned devices are UPS already in ups.conf, by section name. A serial number decides when both sides have
 * one. Without serials, a fixed port (an SNMP address) decides, and as a last resort the USB vendor and product id,
 * but only when exactly one section and one device carry them, since identical models are otherwise ambiguous.
 */
export function matchScanned(devices: ScanDevice[], sections: ConfSection[]): Map<number, string> {
  const matches = new Map<number, string>();
  const used = new Set<string>();
  const claim = (index: number, section: ConfSection) => {
    matches.set(index, section.name);
    used.add(section.name);
  };

  devices.forEach((device, index) => {
    const serial = norm(device.serial ?? device.extra?.serial);
    if (!serial) return;
    const section = sections.find((s) => !used.has(s.name) && norm(s.extra?.serial) === serial);
    if (section) claim(index, section);
  });
  devices.forEach((device, index) => {
    if (matches.has(index) || norm(device.port) === "auto") return;
    const section = sections.find(
      (s) => !used.has(s.name) && norm(s.port) === norm(device.port) && norm(s.driver) === norm(device.driver),
    );
    if (section) claim(index, section);
  });
  devices.forEach((device, index) => {
    const key = deviceIds(device);
    if (matches.has(index) || !key) return;
    const candidates = sections.filter((s) => !used.has(s.name) && !s.extra?.serial && ids(s.extra ?? {}) === key);
    const twins = devices.filter((d, i) => !matches.has(i) && deviceIds(d) === key);
    if (candidates.length === 1 && twins.length === 1) claim(index, candidates[0]);
  });
  return matches;
}

/** A label for a scanned device; identical models get their serial number so they can be told apart. */
export function scanLabel(device: ScanDevice, devices: ScanDevice[]): string {
  const base = [device.vendor, device.product].filter(Boolean).join(" ") || device.desc || device.driver;
  const same = devices.filter((d) => ([d.vendor, d.product].filter(Boolean).join(" ") || d.desc || d.driver) === base);
  const serial = device.serial ?? device.extra?.serial;
  return same.length > 1 && serial ? `${base} (${serial})` : base;
}
