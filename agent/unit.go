package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	unitPath       = "/etc/systemd/system/wolups-agent.service"
	installBinPath = "/usr/local/bin/wolups-agent"
)

// unitContent is the systemd service file. install.sh writes it with `wolups-agent install-unit`,
// and an updated agent rewrites an outdated copy on start, so new service settings arrive with updates.
const unitContent = `[Unit]
Description=WolUPS agent
Documentation=https://github.com/tfourj/WolUPS
After=network-online.target
Wants=network-online.target
# Stop after Proxmox has shut down its guests, so WolUPS still sees the host while VMs and LXCs stop.
# Harmless on hosts without Proxmox.
Before=pve-guests.service

[Service]
Type=simple
ExecStart=` + installBinPath + ` serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=` + defaultStateDir + ` /usr/local/bin
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# Hard limits, so a bug can never fill the disk with logs or eat the host's memory
LogRateLimitIntervalSec=60
LogRateLimitBurst=100
MemoryHigh=64M
MemoryMax=128M

[Install]
WantedBy=multi-user.target
`

func unitUpToDate(path string) bool {
	current, err := os.ReadFile(path)
	return err == nil && bytes.Equal(current, []byte(unitContent))
}

// writeUnit installs the service file if it differs and reloads systemd. It returns whether it changed.
func writeUnit(path string, reload func() error) (bool, error) {
	if unitUpToDate(path) {
		return false, nil
	}
	tmp := filepath.Join(filepath.Dir(path), ".wolups-agent.service.tmp")
	if err := os.WriteFile(tmp, []byte(unitContent), 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, reload()
}

func systemctlReload() error {
	out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl daemon-reload: %v: %s", err, bytes.TrimSpace(out))
	}
	return nil
}

// repairUnit runs when the service starts. The service is sandboxed with a read-only /etc, so it asks
// systemd to run the fixed `install-unit` command outside the sandbox. It returns true when the
// service file was replaced and the agent should restart to run under it.
func repairUnit() bool {
	if os.Getuid() != 0 {
		return false
	}
	if _, err := os.Stat(unitPath); err != nil || unitUpToDate(unitPath) {
		return false
	}
	runner, err := exec.LookPath("systemd-run")
	if err != nil {
		log.Print("service file is outdated and systemd-run is missing; rerun the installer to update it")
		return false
	}
	out, err := exec.Command(runner, "--wait", "--collect", "--quiet", "--unit=wolups-agent-unit-update",
		installBinPath, "install-unit").CombinedOutput()
	if err != nil || !unitUpToDate(unitPath) {
		log.Printf("could not update the service file: %v %s", err, bytes.TrimSpace(out))
		return false
	}
	log.Print("service file updated, restarting to apply it")
	return true
}

func runInstallUnit() error {
	if os.Getuid() != 0 {
		return errors.New("install-unit must run as root")
	}
	changed, err := writeUnit(unitPath, systemctlReload)
	if err != nil {
		return err
	}
	if changed {
		fmt.Println("Service file updated")
	} else {
		fmt.Println("Service file is up to date")
	}
	return nil
}
