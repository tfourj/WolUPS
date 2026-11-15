// Command wolups-nut-agent sets up and manages NUT on a host for WolUPS.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/tfourj/WolUPS/agent/internal/core"
	"github.com/tfourj/WolUPS/agent/internal/nut"
)

var version = "dev"

const (
	stateDir       = "/var/lib/wolups-nut-agent"
	binaryPath     = "/usr/local/bin/wolups-nut-agent"
	reportInterval = 30 * time.Second
)

// The NUT config directories may not exist before NUT is installed, hence the "-" prefix. The agent restarts after
// installing NUT so they become writable.
var unit = fmt.Sprintf(core.UnitTemplate,
	"WolUPS NUT agent",
	binaryPath,
	"",
	stateDir+" /usr/local/bin -/etc/nut -/etc/ups",
	"128M",
	"256M",
)

func component() core.Component {
	return core.Component{
		Name:       "wolups-nut-agent",
		Version:    version,
		TagPrefix:  "nut-agent-v",
		Manifest:   "nut-agent-release.json",
		StateDir:   stateDir,
		BinaryPath: binaryPath,
		UnitPath:   "/etc/systemd/system/wolups-nut-agent.service",
		Unit:       unit,
		Arches:     map[string]string{"amd64": "amd64", "arm64": "arm64", "arm": "armv7"},
	}
}

func main() {
	core.Main(component(), "NUT setup and management agent for WolUPS", func(*core.PersistedState) core.Options {
		dir := os.Getenv("WOLUPS_AGENT_STATE_DIR")
		if dir == "" {
			dir = stateDir
		}
		n := &nutAgent{sys: nut.NewSystem(dir), report: make(chan struct{}, 1)}
		return core.Options{Handlers: n.handlers(), Loops: []func(context.Context, func(any) error){n.reportLoop}}
	})
}

type nutAgent struct {
	sys    *nut.System
	report chan struct{}
	// exit restarts the agent after NUT is installed. Tests replace it.
	exit func(int)
}

// reportSoon asks the report loop to send a health report now.
func (n *nutAgent) reportSoon() {
	select {
	case n.report <- struct{}{}:
	default:
	}
}

type statusMessage struct {
	Type string `json:"type"`
	nut.Status
}

// reportLoop sends a health report when connected, every 30 seconds and after NUT changes.
func (n *nutAgent) reportLoop(ctx context.Context, send func(any) error) {
	ticker := time.NewTicker(reportInterval)
	defer ticker.Stop()
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		status := n.sys.Status(checkCtx)
		cancel()
		if err := send(statusMessage{Type: "nut_status", Status: status}); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-n.report:
		}
	}
}

// toMap turns a result struct into the map an ack carries.
func toMap(value any) map[string]any {
	data, _ := json.Marshal(value)
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	return out
}

func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return errors.New("invalid arguments")
	}
	return nil
}

func (n *nutAgent) handlers() map[string]core.Handler {
	return map[string]core.Handler{
		"nut_detect": {Run: func(ctx context.Context, _ json.RawMessage, _ *core.Output) (core.Reply, error) {
			return core.Reply{Result: toMap(n.sys.Detect(ctx))}, nil
		}},
		"nut_install": {Async: true, Run: n.install},
		"nut_scan":    {Async: true, Run: n.scan},
		"nut_apply": {Async: true, Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var req nut.ApplyRequest
			if err := decode(raw, &req); err != nil {
				return core.Reply{}, err
			}
			result, err := n.sys.Apply(ctx, req)
			n.reportSoon()
			if err != nil {
				return core.Reply{}, err
			}
			log.Printf("applied NUT config for %d managed UPS, changed %v", len(req.UPS), result.Files)
			return core.Reply{Result: toMap(result)}, nil
		}},
		"nut_service": {Async: true, Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Action string `json:"action"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			acc, _ := n.sys.LoadAccounts()
			err := n.sys.Service(ctx, args.Action, acc.LocalShutdown)
			n.reportSoon()
			if err != nil {
				return core.Reply{}, err
			}
			return core.Reply{Result: toMap(n.sys.Status(ctx))}, nil
		}},
		"nut_status": {Run: func(ctx context.Context, _ json.RawMessage, _ *core.Output) (core.Reply, error) {
			return core.Reply{Result: toMap(n.sys.Status(ctx))}, nil
		}},
		"nut_instcmd": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				UPS     string `json:"ups"`
				Command string `json:"command"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			acc, err := n.sys.LoadAccounts()
			if err != nil {
				return core.Reply{}, err
			}
			log.Printf("running %s on %s", args.Command, args.UPS)
			return core.Reply{}, nut.InstCmd(ctx, nut.AdminUser, acc.AdminPassword, args.UPS, args.Command)
		}},
		"nut_setvar": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				UPS   string `json:"ups"`
				Name  string `json:"name"`
				Value string `json:"value"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			acc, err := n.sys.LoadAccounts()
			if err != nil {
				return core.Reply{}, err
			}
			log.Printf("setting %s on %s", args.Name, args.UPS)
			return core.Reply{}, nut.SetVar(ctx, nut.AdminUser, acc.AdminPassword, args.UPS, args.Name, args.Value)
		}},
		"nut_logs": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Lines int `json:"lines"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			lines, err := n.sys.Logs(ctx, args.Lines)
			return core.Reply{Result: map[string]any{"log": lines}}, err
		}},
	}
}

// outsideSandbox runs a package manager command through systemd-run, outside the agent's read-only system.
func outsideSandbox(command []string) (string, []string) {
	if runner, err := exec.LookPath("systemd-run"); err == nil && os.Getuid() == 0 {
		return runner, append([]string{"--wait", "--pipe", "--collect", "--quiet"}, command...)
	}
	return command[0], command[1:]
}

func (n *nutAgent) install(ctx context.Context, _ json.RawMessage, out *core.Output) (core.Reply, error) {
	commands, err := nut.InstallCommands(nut.PackageManager())
	if err != nil {
		return core.Reply{}, err
	}
	for _, command := range commands {
		out.Line("$ " + strings.Join(command, " "))
		name, args := outsideSandbox(command)
		if err := out.Exec(ctx, name, args...); err != nil {
			return core.Reply{}, fmt.Errorf("%s failed: %w", strings.Join(command, " "), err)
		}
	}
	installed := n.sys.NUTVersion(ctx)
	if installed == "" {
		return core.Reply{}, errors.New("NUT was installed but upsd was not found")
	}
	out.Line("NUT " + installed + " installed. Restarting the agent so it can write the NUT config.")
	exit := n.exit
	if exit == nil {
		exit = os.Exit
	}
	return core.Reply{
		Result: map[string]any{"nutVersion": installed},
		After: func() {
			time.Sleep(time.Second)
			// Non-zero exit makes systemd restart the agent, which picks up the new config directory.
			exit(75)
		},
	}, nil
}

func (n *nutAgent) scan(ctx context.Context, raw json.RawMessage, out *core.Output) (core.Reply, error) {
	var req nut.ScanRequest
	if err := decode(raw, &req); err != nil {
		return core.Reply{}, err
	}
	for _, secret := range req.Secrets() {
		out.Mask(secret)
	}
	args, err := req.Args()
	if err != nil {
		return core.Reply{}, err
	}
	scanner, err := exec.LookPath("nut-scanner")
	if err != nil {
		return core.Reply{}, errors.New("nut-scanner is not installed")
	}
	stdout, runErr := out.ExecCapture(ctx, scanner, args...)
	devices := nut.ParseScan(stdout)
	if runErr != nil && len(devices) == 0 && strings.TrimSpace(stdout) != "" {
		return core.Reply{}, fmt.Errorf("nut-scanner failed: %w", runErr)
	}
	if req.SNMP != nil {
		for i := range devices {
			if devices[i].Driver == "snmp-ups" {
				addSNMPSettings(&devices[i], *req.SNMP)
			}
		}
	}
	if devices == nil {
		devices = []nut.Device{}
	}
	out.Line(fmt.Sprintf("Found %d UPS", len(devices)))
	return core.Reply{Result: map[string]any{"devices": devices}}, nil
}

// addSNMPSettings copies the scan's SNMP settings, except passwords, so apply writes a working ups.conf section.
// The wizard sends the passwords again when applying.
func addSNMPSettings(d *nut.Device, s nut.SNMP) {
	if d.Extra == nil {
		d.Extra = map[string]string{}
	}
	d.Extra["snmp_version"] = s.Version
	if s.Version == "v3" {
		d.Extra["secLevel"] = s.SecLevel
		d.Extra["secName"] = s.SecName
		if s.AuthProtocol != "" {
			d.Extra["authProtocol"] = s.AuthProtocol
		}
		if s.PrivProtocol != "" {
			d.Extra["privProtocol"] = s.PrivProtocol
		}
	}
}
