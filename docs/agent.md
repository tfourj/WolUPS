# Agent

The WolUPS agent runs on each Linux machine that WolUPS should shut down, and on any machine that should relay Wake-on-LAN packets. It is a single static binary for amd64 and arm64, managed by systemd.

## Requirements

- Linux with systemd
- Outbound HTTPS to `BASE_URL` and to `github.com` (for install and updates)
- `curl` or `wget`, and `sha256sum`
- Root access

## Install and pair

1. In WolUPS, open **Devices**, then choose **Install agent** on the device.
2. Copy the command and run it on the device as root:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/install.sh | sh -s -- --server https://wolups.example.com --token <token>
   ```

   For a non-root account, pipe to `sudo sh` instead of `sh`. On Proxmox, where `sudo` is not installed, log in as root (`su -`) and run the command as shown.
3. The dialog shows when the agent is paired and connected.
4. Turn on **Automatic shutdown** for the device and set its threshold.

The token can be used once and expires after 15 minutes. If the installer's connection drops after pairing, running the same command again on the same machine still works.

The installer:

- checks that WolUPS is reachable at `/api/health`
- downloads `wolups-agent-linux-<arch>` from the latest GitHub release and verifies its SHA-256 checksum
- installs it to `/usr/local/bin/wolups-agent`
- pairs it and stores the pairing in `/var/lib/wolups-agent/state.json` (root only)
- writes and starts `wolups-agent.service`

Running the installer again without `--token` on a paired machine only upgrades the binary. Use `--allow-http` only if `BASE_URL` is plain http on a trusted LAN.

## How it stays secure

- **Pairing:** the agent generates an Ed25519 key pair locally and sends only the public key, together with the one-time token. WolUPS stores only a hash of the token.
- **Connection:** the agent connects out over a WebSocket at `/api/agents/ws`. Each time, it signs a fresh challenge from the server with its private key.
- **Commands:** every command is signed with the server's own Ed25519 key, addressed to one agent, and expires. The agent rejects anything unsigned, expired, or meant for another agent, even if the TLS proxy were compromised.
- **Duplicates:** a shutdown keeps the same command ID for the whole outage, and the agent remembers IDs it has handled, so retries never power the machine off twice.
- **Fixed actions:** the agent accepts only shutdown (`systemctl poweroff`), wake (a magic packet to a MAC address), update, unpair, and ping. It never runs a command, path, or URL supplied by the server.

## Updates

WolUPS checks the latest GitHub release every few hours (configurable under **Settings**). When a newer agent exists it sends an **Agent update available** event, and updates agents that have **Automatic updates** turned on. **Check for update** in the device menu starts an update right away.

The update request carries no URL. The agent downloads `agent-release.json` and its binary from the release location saved at install time, verifies both checksums, checks that the new binary reports the expected version, swaps it in place, and restarts. When it reconnects with the new version, WolUPS sends an **Agent updated** event. A failed update sends **Agent update failed** with the reason.

## Commands on the device

```bash
wolups-agent status             # server, device name and version
wolups-agent version
wolups-agent reset --confirm    # remove the pairing
journalctl -u wolups-agent -f   # logs
```

## Unpair and uninstall

Choose **Unpair** in the device menu. A connected agent removes its pairing and stops. If the agent is offline, WolUPS forgets it; afterwards run `wolups-agent reset --confirm` on the device before pairing it again.

To remove the agent:

```bash
curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall.sh | sh
```

Add `-s -- --purge` to also delete `/var/lib/wolups-agent`.
