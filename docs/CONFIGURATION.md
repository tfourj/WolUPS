# Configuration

## Setup

1. Open `BASE_URL` and create your account. It is the only account; registration closes afterwards.
2. In **UPS**, add your NUT server. **Find** lists the UPS names it serves, **Test connection** checks the login.
3. In **Devices**, add each machine, pick the UPS that powers it and set a shutdown threshold. The button next to
   the MAC field looks the MAC up from the host's IP.
4. Choose **Install agent** on a device and run the command on that machine (see [Agents](#agents)).
5. In **Channels**, add a channel and press **Test**.

## Environment variables

| Variable             | Default                 | Description                                                    |
| -------------------- | ----------------------- | -------------------------------------------------------------- |
| `PORT`               | `4321`                  | Port the app listens on                                        |
| `BASE_URL`           | `http://localhost:PORT` | Public URL, used for login cookies and agent install commands  |
| `BETTER_AUTH_SECRET` | generated               | Session signing secret, at least 32 characters                 |
| `ENCRYPTION_SECRET`  | generated               | Key for encrypting NUT passwords and channel credentials       |
| `TZ`                 | `UTC`                   | Timezone for `{time}` in notifications                         |
| `LOG_LEVEL`          | `info`                  | `debug`, `info`, `warn` or `error`                             |

Missing secrets are generated into `/data/secrets.json`. All data lives in the `/data` volume; back it up as a whole.
Without the encryption secret, stored credentials cannot be decrypted and agents must be paired again.

## Agents

The agent runs on Linux with systemd (amd64 or arm64). It connects out to `BASE_URL`, so the device needs no open
port. Run the command from **Install agent** as root:

```bash
curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/install.sh | sh -s -- --server https://wolups.example.com --token <token>
```

On Proxmox you are already root. Elsewhere use `| sudo sh -s -- ...`. The token works once and expires after 15
minutes.

The agent only accepts signed commands from your WolUPS server: shut down, send a wake packet, update, unpair and
ping. WolUPS checks for a new agent release every 15 minutes (**Settings → General**). New agents
install it automatically (turn off **Automatic updates** in the device menu to opt out); offline agents update
when they reconnect. **Check for update** updates right away and tells you if the agent is already current. Updates
also refresh the agent's systemd service file, so reinstalling is never needed.

```bash
wolups-agent status              # pairing and version
journalctl -u wolups-agent -f    # logs
curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall.sh | sh    # remove
```

If you unpair an offline agent, run `wolups-agent reset --confirm` on the device before pairing it again.

## Wake-on-LAN

Wake packets only reach your LAN from the container with `network_mode: host`. Without it, an online agent on the
same network sends them. Choose server, agent or both in **Settings → Wake**. MAC lookup uses the same
route: the server's ARP table on host networking, otherwise an agent on the same subnet.

**Settings → Wake** shows whether the server and each agent can send, and which devices they reach.
**Check Wake-on-LAN** in the device menu shows whether the server or an agent can reach the device and sends a
harmless test packet (MAC `00:00:00:00:00:00`) from each.

Devices are woken once power is back for the delay in **Settings → Wake** and the UPS battery is above its minimum.
Each device can override both, for example to wake a desktop only above 80%. If a device stays offline for the
timeout after its first wake packet, or the conditions are not met within 24 hours, WolUPS stops and notifies you.

## Notifications

Templates are set in **Settings → Templates** and can be overridden per channel. Variables:

`{event}` `{title}` `{message}` `{ups}` `{device}` `{battery}` `{runtime}` `{status}` `{threshold}` `{version}` `{time}`

Failed deliveries are retried up to 6 times. Each attempt is shown in **Events**, where you can also retry by hand.

## Reverse proxy, Coolify and Cloudflare

- Set `BASE_URL` to the public HTTPS URL.
- **Coolify:** deploy `docker-compose.yml`, set the domain and env vars, and keep `/data` on a persistent volume.
- **Cloudflare:** agents can be blocked as bots. Disable **Bot Fight Mode**, or add a WAF custom rule that skips
  security features for `starts_with(http.request.uri.path, "/api/agents/")`.

## Reset password

```bash
docker exec -it wolups bun src/server/cli.ts reset-password 'new-password'
```
