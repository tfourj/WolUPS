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
| `TZ`                 | `UTC`                   | Default timezone for `{time}` in notifications                 |
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

## NUT hosts

The NUT agent sets up NUT on the machine your UPS is plugged into (Linux with systemd: amd64, arm64 or armv7).
Choose **Add NUT host** in **UPS** and follow the steps:

1. **Install.** Run the install command on that machine as root, like the device agent.
2. **Check.** If NUT is missing, **Install NUT** installs it with apt, dnf or pacman.
3. **Scan.** Find UPS units over USB or SNMP (v1, v2c or v3), or import ones already in `ups.conf`.
4. **Configure.** Pick the address upsd listens on. The WolUPS server must reach it on port 3493.
5. **Apply.** The agent writes the config and restarts NUT. WolUPS adds each UPS once it can read it.

The agent only changes lines between `# BEGIN wolups` and `# END wolups` in `ups.conf`, `upsd.conf`, `upsd.users`
and `upsmon.conf`, sets `MODE=netserver` in `nut.conf`, and keeps a `.wolups-<time>` backup of each file it
changes. SNMP passwords are written to `ups.conf` only, never stored by WolUPS.

**Manage** in a UPS menu runs instant commands, changes writable settings and removes the UPS from NUT. The host
card menu adds more UPS, restarts NUT and shows its logs. **NUT service failed** and **NUT service recovered**
notify you when a driver, upsd or upsmon stops or upsd stops listening.

```bash
wolups-nut-agent status              # pairing and version
journalctl -u wolups-nut-agent -f    # logs
curl -fsSL https://raw.githubusercontent.com/tfourj/WolUPS/main/agent/uninstall-nut.sh | sh    # remove, NUT stays
```

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

`{event}` `{title}` `{message}` `{ups}` `{device}` `{count}` `{battery}` `{runtime}` `{status}` `{threshold}`
`{version}` `{duration}` `{error}` `{via}` `{time}`

**Preview** shows a template filled in with an example event.

A line whose variables are all empty for an event is left out, so a template can list values that only some
events carry.

Agent update events (available, updated, failed) that follow each other within a minute are sent as one event, at
most 5 minutes after the first. `{device}` then lists every device and `{count}` is the number of agents. For a
single agent `{count}` is empty.

The preset menu in **Settings → Templates** fills in every event at once: Default, Minimalistic or Detailed, each
also with icons. The icon presets write the message themselves instead of using `{message}`. Presets can be edited
afterwards and apply once saved.

`{time}` uses the timezone and clock set in **Settings → General → Time display**, which also sets how the app
shows dates.

Failed deliveries are retried up to 6 times. Each attempt is shown in **Events**, where you can also retry by hand.

## Account security

**Settings → Security** has three options:

- **Two-factor authentication:** scan the QR code with an authenticator app and enter a code to turn it on. Save the
  10 backup codes it shows; each works once. Sign-ins then ask for a code, and **Trust this device** skips it for 30
  days.
- **Login notifications:** pick the channels that get a message for every sign-in, with the method, device and IP
  address. This is the **New sign-in** event in each channel's event list. **Send test** sends a sample.
- **Devices:** lists every signed-in device with its browser, IP address, last activity and sign-in time. Tick
  devices and use **Sign out selected**, or **Sign out all** to sign out everywhere, including the current device.

## Reverse proxy, Coolify and Cloudflare

- Set `BASE_URL` to the public HTTPS URL.
- **Coolify:** deploy `docker-compose.yml`, set the domain and env vars, and keep `/data` on a persistent volume.
- **Cloudflare:** agents can be blocked as bots. Disable **Bot Fight Mode**, or add a WAF custom rule that skips
  security features for `starts_with(http.request.uri.path, "/api/agents/")`.

## Reset password

```bash
docker exec -it wolups bun src/server/cli.ts reset-password 'new-password'
```

If you lose your authenticator app and backup codes, turn off two-factor authentication:

```bash
docker exec -it wolups bun src/server/cli.ts disable-2fa
```
