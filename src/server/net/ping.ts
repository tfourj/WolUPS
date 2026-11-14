/** ICMP reachability check using the system ping binary (iputils-ping in the container). */
export async function ping(host: string, timeoutMs = 3000): Promise<boolean> {
  if (!/^[A-Za-z0-9.:_-]+$/.test(host)) return false;
  try {
    const proc = Bun.spawn(["ping", "-c", "1", "-W", "2", host], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}
