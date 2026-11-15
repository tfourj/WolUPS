package core

import (
	"fmt"
	"runtime"
)

// Component describes one agent program: its names, paths, release assets and service file.
type Component struct {
	// Name is the binary and service name, for example wolups-agent.
	Name    string
	Version string
	// TagPrefix selects this component's GitHub releases, for example agent-v.
	TagPrefix string
	// Manifest is the release file with the version and protocol, for example agent-release.json.
	Manifest   string
	StateDir   string
	BinaryPath string
	UnitPath   string
	// Unit is the systemd service file.
	Unit string
	// Arches maps GOARCH to the asset suffix, for example arm to armv7.
	Arches map[string]string
}

// Asset is the release file name of the binary for an architecture.
func (c Component) Asset(goarch string) (string, error) {
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	suffix, ok := c.Arches[goarch]
	if !ok {
		return "", fmt.Errorf("unsupported architecture %s", goarch)
	}
	return c.Name + "-linux-" + suffix, nil
}

// VersionLine is what `<name> version` prints. Updates check a downloaded binary against it.
func (c Component) VersionLine(version string) string {
	return fmt.Sprintf("%s %s protocol v%d", c.Name, version, ProtocolVersion)
}
