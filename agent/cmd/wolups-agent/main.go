// Command wolups-agent shuts down and wakes machines for WolUPS.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/tfourj/WolUPS/agent/internal/core"
)

var version = "dev"

const (
	stateDir   = "/var/lib/wolups-agent"
	binaryPath = "/usr/local/bin/wolups-agent"
)

var unit = fmt.Sprintf(core.UnitTemplate,
	"WolUPS agent",
	binaryPath,
	`# Stop after Proxmox has shut down its guests, so WolUPS still sees the host while VMs and LXCs stop.
# Harmless on hosts without Proxmox.
Before=pve-guests.service
`,
	stateDir+" /usr/local/bin",
	"64M",
	"128M",
)

func component() core.Component {
	return core.Component{
		Name:       "wolups-agent",
		Version:    version,
		TagPrefix:  "agent-v",
		Manifest:   "agent-release.json",
		StateDir:   stateDir,
		BinaryPath: binaryPath,
		UnitPath:   "/etc/systemd/system/wolups-agent.service",
		Unit:       unit,
		Arches:     map[string]string{"amd64": "amd64", "arm64": "arm64"},
	}
}

func main() {
	core.Main(component(), "UPS shutdown and wake agent for WolUPS", func(*core.PersistedState) core.Options {
		return core.Options{Handlers: handlers(systemActions())}
	})
}

// actions are the device side effects the server can trigger.
type actions struct {
	poweroff func() error
	wake     func(mac, broadcast string, port int) (int, error)
	resolve  func(ip string) (string, error)
}

func systemActions() actions {
	dryRun := os.Getenv("WOLUPS_AGENT_DRY_RUN") == "1"
	return actions{
		poweroff: func() error {
			if dryRun {
				log.Print("dry run: would power off now")
				return nil
			}
			for _, path := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
				if _, err := os.Stat(path); err == nil {
					return exec.Command(path, "poweroff").Run()
				}
			}
			return errors.New("systemctl not found")
		},
		wake:    sendWake,
		resolve: lookupMAC,
	}
}

type shutdownArgs struct {
	Reason    string `json:"reason"`
	UPS       string `json:"ups"`
	Battery   *int   `json:"battery"`
	Threshold *int   `json:"threshold"`
}

type wakeArgs struct {
	MAC       string `json:"mac"`
	Broadcast string `json:"broadcast"`
	Port      int    `json:"port"`
}

func handlers(acts actions) map[string]core.Handler {
	return map[string]core.Handler{
		"shutdown": {Run: func(_ context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args shutdownArgs
			_ = json.Unmarshal(raw, &args)
			log.Printf("shutdown requested (reason=%s ups=%s)", args.Reason, args.UPS)
			return core.Reply{After: func() {
				go func() {
					time.Sleep(2 * time.Second)
					if err := acts.poweroff(); err != nil {
						log.Printf("poweroff failed: %v", err)
					}
				}()
			}}, nil
		}},
		"wol": {Run: func(_ context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args wakeArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return core.Reply{}, errors.New("invalid wake arguments")
			}
			sent, err := acts.wake(args.MAC, args.Broadcast, args.Port)
			if err != nil {
				log.Printf("wake packet for %s failed: %v", args.MAC, err)
			} else {
				log.Printf("sent wake packet for %s to %d target(s)", args.MAC, sent)
			}
			return core.Reply{Result: map[string]any{"targets": sent}}, err
		}},
		"resolve_mac": {Run: func(_ context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				IP string `json:"ip"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return core.Reply{}, errors.New("invalid arguments")
			}
			mac, err := acts.resolve(args.IP)
			return core.Reply{Result: map[string]any{"mac": mac}}, err
		}},
	}
}
