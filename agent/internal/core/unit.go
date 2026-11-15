package core

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// UnitTemplate is the common systemd service file: %[1]s description, %[2]s binary, %[3]s extra [Unit] lines,
// %[4]s writable paths, %[5]s and %[6]s the memory limits. An updated agent rewrites an outdated copy on start, so
// new service settings arrive with updates.
const UnitTemplate = `[Unit]
Description=%[1]s
Documentation=https://github.com/tfourj/WolUPS
After=network-online.target
Wants=network-online.target
%[3]s
[Service]
Type=simple
ExecStart=%[2]s serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=%[4]s
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# Hard limits, so a bug can never fill the disk with logs or eat the host's memory
LogRateLimitIntervalSec=60
LogRateLimitBurst=100
MemoryHigh=%[5]s
MemoryMax=%[6]s

[Install]
WantedBy=multi-user.target
`

func unitUpToDate(path, content string) bool {
	current, err := os.ReadFile(path)
	return err == nil && bytes.Equal(current, []byte(content))
}

// writeUnit installs the service file if it differs and reloads systemd. It returns whether it changed.
func writeUnit(path, content string, reload func() error) (bool, error) {
	if unitUpToDate(path, content) {
		return false, nil
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
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
func repairUnit(c Component) bool {
	if os.Getuid() != 0 {
		return false
	}
	if _, err := os.Stat(c.UnitPath); err != nil || unitUpToDate(c.UnitPath, c.Unit) {
		return false
	}
	runner, err := exec.LookPath("systemd-run")
	if err != nil {
		log.Print("service file is outdated and systemd-run is missing; rerun the installer to update it")
		return false
	}
	out, err := exec.Command(runner, "--wait", "--collect", "--quiet", "--unit="+c.Name+"-unit-update",
		c.BinaryPath, "install-unit").CombinedOutput()
	if err != nil || !unitUpToDate(c.UnitPath, c.Unit) {
		log.Printf("could not update the service file: %v %s", err, bytes.TrimSpace(out))
		return false
	}
	log.Print("service file updated, restarting to apply it")
	return true
}

// InstallUnit writes the component's service file, for `<name> install-unit`.
func InstallUnit(c Component) error {
	if os.Getuid() != 0 {
		return errors.New("install-unit must run as root")
	}
	changed, err := writeUnit(c.UnitPath, c.Unit, systemctlReload)
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
