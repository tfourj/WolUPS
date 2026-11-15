package nut

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// System runs NUT tools and reads and writes NUT files. Tests swap Run and the directories.
type System struct {
	// ConfigDirs are checked in order for an existing NUT config.
	ConfigDirs []string
	// StateDir holds nut.json with the WolUPS account passwords and listen address.
	StateDir string
	// Run executes a fixed command and returns its combined output.
	Run func(ctx context.Context, name string, args ...string) (string, error)
	Now func() time.Time
}

// NewSystem is the real system.
func NewSystem(stateDir string) *System {
	return &System{
		ConfigDirs: []string{"/etc/nut", "/etc/ups"},
		StateDir:   stateDir,
		Run: func(ctx context.Context, name string, args ...string) (string, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Env = append(os.Environ(), "LC_ALL=C")
			out, err := cmd.CombinedOutput()
			return string(out), err
		},
		Now: time.Now,
	}
}

// Detected describes the host for the setup wizard.
type Detected struct {
	OS             string   `json:"os"`
	PackageManager string   `json:"packageManager"`
	NUTVersion     string   `json:"nutVersion"`
	ConfigDir      string   `json:"configDir"`
	Services       Services `json:"services"`
	// Existing are sections outside the WolUPS block, Managed the ones inside. Passwords are left out of both.
	Existing []Section `json:"existing"`
	Managed  []Section `json:"managed"`
}

// Services are the states of upsd and upsmon: running, stopped, failed or missing.
type Services struct {
	Upsd   string `json:"upsd"`
	Upsmon string `json:"upsmon"`
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// PackageManager is apt, dnf or pacman, or empty when none is found.
func PackageManager() string {
	for _, pm := range []string{"apt-get", "dnf", "pacman"} {
		if lookPath(pm) {
			return strings.TrimSuffix(pm, "-get")
		}
	}
	return ""
}

func osName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			return strings.Trim(value, `"`)
		}
	}
	return "Linux"
}

var versionPattern = regexp.MustCompile(`(\d+\.\d+(\.\d+)?)`)

// NUTVersion is the installed NUT version from `upsd -V`, or empty when NUT is not installed.
func (s *System) NUTVersion(ctx context.Context) string {
	for _, path := range []string{"upsd", "/usr/sbin/upsd", "/sbin/upsd", "/usr/lib/nut/upsd"} {
		out, err := s.Run(ctx, path, "-V")
		if err == nil || strings.Contains(out, "Network UPS Tools") {
			if match := versionPattern.FindString(out); match != "" {
				return match
			}
		}
	}
	return ""
}

// LegacyRoles is true for NUT before 2.8, which calls upsmon roles master and slave.
func LegacyRoles(version string) bool {
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return false
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	return major < 2 || (major == 2 && minor < 8)
}

// ConfigDir is the NUT config directory: an existing one, else the distribution's default.
func (s *System) ConfigDir() string {
	for _, dir := range s.ConfigDirs {
		if _, err := os.Stat(filepath.Join(dir, "ups.conf")); err == nil {
			return dir
		}
	}
	for _, dir := range s.ConfigDirs {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	if PackageManager() == "dnf" && len(s.ConfigDirs) > 1 {
		return s.ConfigDirs[1]
	}
	return s.ConfigDirs[0]
}

// unitState maps `systemctl is-active` to running, stopped, failed or missing.
func (s *System) unitState(ctx context.Context, unit string) string {
	out, err := s.Run(ctx, "systemctl", "is-active", unit)
	state := strings.TrimSpace(out)
	switch {
	case err == nil && state == "active":
		return "running"
	case state == "failed":
		return "failed"
	case state == "inactive" || state == "deactivating" || state == "activating":
		if loaded, _ := s.Run(ctx, "systemctl", "show", "-p", "LoadState", "--value", unit); strings.TrimSpace(loaded) == "not-found" {
			return "missing"
		}
		return "stopped"
	default:
		return "missing"
	}
}

// Detect describes the host and any NUT setup on it.
func (s *System) Detect(ctx context.Context) Detected {
	dir := s.ConfigDir()
	existing, managed := []Section{}, []Section{}
	withoutSecrets := func(sections []Section) []Section {
		for _, section := range sections {
			for key := range section.Extra {
				if SecretKeys[key] {
					delete(section.Extra, key)
				}
			}
		}
		return sections
	}
	if data, err := os.ReadFile(filepath.Join(dir, "ups.conf")); err == nil {
		existing = append(existing, withoutSecrets(ParseUpsConf(outsideBlock(string(data))))...)
		managed = append(managed, withoutSecrets(ManagedSections(string(data)))...)
	}
	return Detected{
		OS:             osName(),
		PackageManager: PackageManager(),
		NUTVersion:     s.NUTVersion(ctx),
		ConfigDir:      dir,
		Services:       Services{Upsd: s.unitState(ctx, "nut-server"), Upsmon: s.unitState(ctx, "nut-monitor")},
		Existing:       existing,
		Managed:        managed,
	}
}

// InstallCommands are the package manager commands that install NUT. They run outside the agent's sandbox.
func InstallCommands(pm string) ([][]string, error) {
	switch pm {
	case "apt":
		return [][]string{{"apt-get", "update"}, {"apt-get", "install", "-y", "nut-server", "nut-client"}}, nil
	case "dnf":
		return [][]string{{"dnf", "install", "-y", "nut", "nut-client"}}, nil
	case "pacman":
		return [][]string{{"pacman", "-Sy", "--noconfirm", "--needed", "nut"}}, nil
	}
	return nil, errors.New("no supported package manager (apt, dnf or pacman) found; install NUT by hand")
}

// Accounts are the WolUPS NUT passwords and the address upsd listens on, kept in nut.json.
type Accounts struct {
	Users
	Listen        string `json:"listen,omitempty"`
	LocalShutdown bool   `json:"localShutdown,omitempty"`
}

func (s *System) accountsPath() string { return filepath.Join(s.StateDir, "nut.json") }

func randomPassword() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// LoadAccounts reads nut.json, creating passwords on first use.
func (s *System) LoadAccounts() (Accounts, error) {
	var acc Accounts
	if data, err := os.ReadFile(s.accountsPath()); err == nil {
		if err := json.Unmarshal(data, &acc); err != nil {
			return acc, fmt.Errorf("nut.json: %w", err)
		}
	}
	var err error
	if acc.MonitorPassword == "" {
		if acc.MonitorPassword, err = randomPassword(); err != nil {
			return acc, err
		}
	}
	if acc.AdminPassword == "" {
		if acc.AdminPassword, err = randomPassword(); err != nil {
			return acc, err
		}
	}
	return acc, nil
}

// SaveAccounts writes nut.json, root only.
func (s *System) SaveAccounts(acc Accounts) error {
	if err := os.MkdirAll(s.StateDir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(acc, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.accountsPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.accountsPath())
}

// writeFile replaces a NUT file when its content changes, keeping a backup and the original owner and mode. New
// files get root:nut 0640, so NUT's daemons can read them and nobody else can.
func (s *System) writeFile(path, content string) (bool, error) {
	current, err := os.ReadFile(path)
	if err == nil && string(current) == content {
		return false, nil
	}
	if errors.Is(err, os.ErrNotExist) && content == "" {
		// Nothing to write, for example upsmon.conf when this host does not shut itself down.
		return false, nil
	}
	mode := os.FileMode(0o640)
	uid, gid := 0, nutGroup()
	if err == nil {
		backup := fmt.Sprintf("%s.wolups-%s", path, s.Now().UTC().Format("20060102T150405Z"))
		if err := os.WriteFile(backup, current, 0o600); err != nil {
			return false, fmt.Errorf("back up %s: %w", path, err)
		}
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				uid, gid = int(st.Uid), int(st.Gid)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".wolups.tmp")
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return false, err
	}
	if os.Getuid() == 0 {
		_ = os.Chown(tmp, uid, gid)
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, nil
}

func nutGroup() int {
	group, err := user.LookupGroup("nut")
	if err != nil {
		return 0
	}
	gid, _ := strconv.Atoi(group.Gid)
	return gid
}

func readFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(data), err
}

// ApplyRequest is the nut_apply command. UPS sections are added or replaced, Remove drops managed sections by name,
// and every other managed section is kept.
type ApplyRequest struct {
	UPS           []Section `json:"ups"`
	Remove        []string  `json:"remove,omitempty"`
	Listen        string    `json:"listen"`
	LocalShutdown bool      `json:"localShutdown"`
}

// ApplyResult tells the server which files changed and how to log in.
type ApplyResult struct {
	Files           []string `json:"files"`
	MonitorUser     string   `json:"monitorUser"`
	MonitorPassword string   `json:"monitorPassword"`
}

// Apply writes the NUT config for the request and restarts NUT. Sections outside the WolUPS block stay as they are.
func (s *System) Apply(ctx context.Context, req ApplyRequest) (ApplyResult, error) {
	version := s.NUTVersion(ctx)
	if version == "" {
		return ApplyResult{}, errors.New("NUT is not installed")
	}
	dir := s.ConfigDir()
	acc, err := s.LoadAccounts()
	if err != nil {
		return ApplyResult{}, err
	}
	legacy := LegacyRoles(version)

	upsConfPath := filepath.Join(dir, "ups.conf")
	upsConf, err := readFile(upsConfPath)
	if err != nil {
		return ApplyResult{}, err
	}
	newUpsConf, err := RenderUpsConf(upsConf, req.UPS, req.Remove)
	if err != nil {
		return ApplyResult{}, err
	}
	var names []string
	for _, section := range ParseUpsConf(newUpsConf) {
		names = append(names, section.Name)
	}

	files := map[string]func(string) (string, error){
		upsConfPath:                      func(string) (string, error) { return newUpsConf, nil },
		filepath.Join(dir, "upsd.conf"):  func(cur string) (string, error) { return RenderUpsdConf(cur, req.Listen) },
		filepath.Join(dir, "upsd.users"): func(cur string) (string, error) { return RenderUsers(cur, acc.Users, legacy), nil },
		filepath.Join(dir, "nut.conf"):   func(cur string) (string, error) { return RenderNutConf(cur), nil },
		filepath.Join(dir, "upsmon.conf"): func(cur string) (string, error) {
			return RenderUpsmonConf(cur, names, acc.Users, req.LocalShutdown, legacy), nil
		},
	}
	// Render everything before writing anything, so a bad value leaves the config untouched.
	rendered := map[string]string{}
	for path, render := range files {
		current, err := readFile(path)
		if err != nil {
			return ApplyResult{}, err
		}
		if rendered[path], err = render(current); err != nil {
			return ApplyResult{}, err
		}
	}
	changed := []string{}
	for _, path := range []string{upsConfPath, filepath.Join(dir, "upsd.conf"), filepath.Join(dir, "upsd.users"),
		filepath.Join(dir, "nut.conf"), filepath.Join(dir, "upsmon.conf")} {
		wrote, err := s.writeFile(path, rendered[path])
		if err != nil {
			return ApplyResult{}, fmt.Errorf("write %s: %w", path, err)
		}
		if wrote {
			changed = append(changed, path)
		}
	}
	acc.Listen, acc.LocalShutdown = req.Listen, req.LocalShutdown
	if err := s.SaveAccounts(acc); err != nil {
		return ApplyResult{}, err
	}
	if err := s.Service(ctx, "restart", req.LocalShutdown); err != nil {
		return ApplyResult{}, err
	}
	return ApplyResult{Files: changed, MonitorUser: MonitorUser, MonitorPassword: acc.MonitorPassword}, nil
}

func (s *System) unitExists(ctx context.Context, unit string) bool {
	out, _ := s.Run(ctx, "systemctl", "show", "-p", "LoadState", "--value", unit)
	return strings.TrimSpace(out) == "loaded"
}

// Service starts, stops or restarts the NUT drivers and upsd, and upsmon when it shuts this host down.
func (s *System) Service(ctx context.Context, action string, withMonitor bool) error {
	if action != "start" && action != "stop" && action != "restart" {
		return fmt.Errorf("unknown action %q", action)
	}
	var units []string
	if s.unitExists(ctx, "nut-driver-enumerator.service") {
		// NUT 2.8 makes one nut-driver@<ups> unit per section; refresh them from ups.conf first.
		if action != "stop" {
			if out, err := s.Run(ctx, "systemctl", "restart", "nut-driver-enumerator.service"); err != nil {
				return fmt.Errorf("nut-driver-enumerator: %v: %s", err, strings.TrimSpace(out))
			}
		}
		units = append(units, "nut-driver.target")
	} else if s.unitExists(ctx, "nut-driver.service") {
		units = append(units, "nut-driver.service")
	}
	units = append(units, "nut-server.service")
	if withMonitor || action == "stop" {
		units = append(units, "nut-monitor.service")
	}
	if action != "stop" {
		args := append([]string{"enable"}, units...)
		if out, err := s.Run(ctx, "systemctl", args...); err != nil {
			return fmt.Errorf("systemctl enable: %v: %s", err, strings.TrimSpace(out))
		}
	}
	args := append([]string{action}, units...)
	if out, err := s.Run(ctx, "systemctl", args...); err != nil {
		return fmt.Errorf("systemctl %s: %v: %s", action, err, strings.TrimSpace(out))
	}
	return nil
}

// Status is a health report, sent as a nut_status message and as the nut_status command's result.
type Status struct {
	Upsd      string         `json:"upsd"`
	Upsmon    string         `json:"upsmon"`
	Listening bool           `json:"listening"`
	Drivers   []DriverStatus `json:"drivers"`
}

type DriverStatus struct {
	UPS   string `json:"ups"`
	State string `json:"state"`
}

// Status checks upsd, upsmon, the listen address and each UPS's driver. Drivers are asked through upsd, so they
// are only listed while upsd runs.
func (s *System) Status(ctx context.Context) Status {
	st := Status{Upsd: s.unitState(ctx, "nut-server"), Upsmon: s.unitState(ctx, "nut-monitor"), Drivers: []DriverStatus{}}
	acc, _ := s.LoadAccounts()
	if acc.Listen != "" {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(acc.Listen, strconv.Itoa(NUTPort)), 2*time.Second)
		if err == nil {
			conn.Close()
			st.Listening = true
		}
	} else {
		st.Listening = st.Upsd == "running"
	}
	if st.Upsd != "running" {
		return st
	}
	data, err := readFile(filepath.Join(s.ConfigDir(), "ups.conf"))
	if err != nil {
		return st
	}
	for _, section := range ParseUpsConf(data) {
		st.Drivers = append(st.Drivers, DriverStatus{UPS: section.Name, State: driverState(ctx, section.Name)})
	}
	return st
}

// driverState asks the local upsd for the UPS's status: running, stopped (driver not connected) or stale.
func driverState(ctx context.Context, ups string) string {
	client, err := Dial(ctx, fmt.Sprintf("127.0.0.1:%d", NUTPort))
	if err != nil {
		return "unknown"
	}
	defer client.Close()
	_, err = client.Command(fmt.Sprintf("GET VAR %s ups.status", ups))
	switch {
	case err == nil:
		return "running"
	case strings.Contains(err.Error(), "DRIVER-NOT-CONNECTED"):
		return "stopped"
	case strings.Contains(err.Error(), "DATA-STALE"):
		return "stale"
	case strings.Contains(err.Error(), "UNKNOWN-UPS"):
		return "missing"
	default:
		return "unknown"
	}
}

// Logs returns recent lines from NUT's services.
func (s *System) Logs(ctx context.Context, lines int) ([]string, error) {
	if lines < 10 || lines > 500 {
		lines = 200
	}
	out, err := s.Run(ctx, "journalctl", "--no-pager", "-o", "short-iso", "-n", strconv.Itoa(lines),
		"-u", "nut-server", "-u", "nut-monitor", "-u", "nut-driver@*", "-u", "nut-driver", "-u", "nut-driver-enumerator")
	if err != nil && strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("journalctl: %w", err)
	}
	var result []string
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		result = append(result, scanner.Text())
	}
	return result, nil
}
