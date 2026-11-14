import { createSocket } from "node:dgram";

export function parseMac(value: string): Buffer | null {
  const hex = value.trim().replace(/[:\-.]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export function normalizeMac(value: string): string | null {
  const mac = parseMac(value);
  return mac ? [...mac].map((b) => b.toString(16).padStart(2, "0")).join(":") : null;
}

export function magicPacket(mac: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

/** Send a magic packet from the server. Only reaches the LAN when the container uses host networking. */
export function sendMagicPacket(macValue: string, broadcast = "255.255.255.255", port = 9): Promise<void> {
  const mac = parseMac(macValue);
  if (!mac) return Promise.reject(new Error("invalid MAC address"));
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
