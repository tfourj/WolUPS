package nut

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var rack = Section{Name: "rack", Driver: "usbhid-ups", Port: "auto", Desc: "Rack UPS",
	Extra: map[string]string{"vendorid": "0764", "productid": "0501"}}

func TestRenderUpsConfFresh(t *testing.T) {
	got, err := RenderUpsConf("", []Section{rack})
	if err != nil {
		t.Fatal(err)
	}
	want := `# BEGIN wolups
# Written by wolups-nut-agent. Changes inside this block are replaced.
[rack]
	driver = "usbhid-ups"
	port = "auto"
	desc = "Rack UPS"
	productid = "0501"
	vendorid = "0764"
# END wolups
`
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if sections := ParseUpsConf(got); len(sections) != 1 || sections[0].Extra["vendorid"] != "0764" {
		t.Fatalf("does not parse back: %+v", sections)
	}
}

func TestRenderUpsConfKeepsExistingAndReplacesBlock(t *testing.T) {
	existing := "maxretry = 3\n\n[old]\n\tdriver = blazer_usb\n\tport = auto\n"
	first, err := RenderUpsConf(existing, []Section{rack})
	if err != nil {
		t.Fatal(err)
	}
	second, err := RenderUpsConf(first, []Section{{Name: "spare", Driver: "usbhid-ups", Port: "auto"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(second, existing) || strings.Contains(second, "[rack]") || !strings.Contains(second, "[spare]") {
		t.Fatalf("block not replaced in place:\n%s", second)
	}
	if strings.Count(second, blockBegin) != 1 {
		t.Fatal("block duplicated")
	}
	empty, _ := RenderUpsConf(second, nil)
	if empty != existing {
		t.Fatalf("removing every managed UPS should leave the original file, got:\n%q", empty)
	}
	if _, err := RenderUpsConf(existing, []Section{{Name: "old", Driver: "usbhid-ups", Port: "auto"}}); err == nil {
		t.Fatal("managed section clashing with an existing one accepted")
	}
}

func TestSectionValidation(t *testing.T) {
	bad := []Section{
		{Name: "Rack UPS", Driver: "usbhid-ups", Port: "auto"},
		{Name: "rack", Driver: "usbhid-ups\n\tport = x", Port: "auto"},
		{Name: "rack", Driver: "usbhid-ups", Port: "auto", Desc: `say "hi"`},
		{Name: "rack", Driver: "usbhid-ups", Port: "auto", Extra: map[string]string{"maxretry": "1"}},
		{Name: "rack", Driver: "snmp-ups", Port: "10.0.0.2", Extra: map[string]string{"authPassword": "short"}},
	}
	for _, s := range bad {
		if s.Validate() == nil {
			t.Errorf("accepted %+v", s)
		}
	}
	good := Section{Name: "rack", Driver: "snmp-ups", Port: "10.0.0.2",
		Extra: map[string]string{"snmp_version": "v3", "authPassword": "pass with spaces"}}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestRenderOtherFiles(t *testing.T) {
	upsd, err := RenderUpsdConf("MAXAGE 15\n", "192.168.1.5")
	if err != nil || !strings.Contains(upsd, "MAXAGE 15") || !strings.Contains(upsd, "LISTEN 192.168.1.5 3493") ||
		!strings.Contains(upsd, "LISTEN 127.0.0.1 3493") {
		t.Fatalf("upsd.conf: %v\n%s", err, upsd)
	}
	if _, err := RenderUpsdConf("", "0.0.0.0 3493\nLISTEN x"); err == nil {
		t.Fatal("bad listen address accepted")
	}
	users := RenderUsers("", Users{MonitorPassword: "m", AdminPassword: "a"}, false)
	if !strings.Contains(users, "upsmon secondary") || !strings.Contains(users, "instcmds = ALL") {
		t.Fatalf("users: %s", users)
	}
	if legacy := RenderUsers("", Users{}, true); !strings.Contains(legacy, "upsmon slave") {
		t.Fatal("NUT 2.7 roles not used")
	}
	if got := RenderNutConf("# comment\nMODE=standalone\n"); got != "# comment\nMODE=netserver\n" {
		t.Fatalf("nut.conf: %q", got)
	}
	if got := RenderNutConf(""); got != "MODE=netserver\n" {
		t.Fatalf("nut.conf: %q", got)
	}
	monitor := RenderUpsmonConf("SHUTDOWNCMD x\n", []string{"rack"}, Users{AdminPassword: "a"}, true, false)
	if !strings.Contains(monitor, `MONITOR rack@localhost 1 wolups-admin "a" primary`) {
		t.Fatalf("upsmon.conf: %s", monitor)
	}
	if off := RenderUpsmonConf(monitor, []string{"rack"}, Users{}, false, false); off != "SHUTDOWNCMD x\n" {
		t.Fatalf("upsmon block not removed: %q", off)
	}
}

func TestLegacyRoles(t *testing.T) {
	for version, want := range map[string]bool{"2.7.4": true, "2.8.0": false, "2.8.2": false, "3.0": false, "": false} {
		if LegacyRoles(version) != want {
			t.Errorf("LegacyRoles(%q) != %v", version, want)
		}
	}
}

func TestScanArgs(t *testing.T) {
	args, err := ScanRequest{USB: true}.Args()
	if err != nil || strings.Join(args, " ") != "-U" {
		t.Fatalf("usb: %v %v", args, err)
	}
	v2 := ScanRequest{SNMP: &SNMP{Start: "10.0.0.1", End: "10.0.0.9", Version: "v2c", Community: "public"}}
	args, _ = v2.Args()
	if strings.Join(args, " ") != "-S -s 10.0.0.1 -e 10.0.0.9 -c public" {
		t.Fatalf("v2c: %v", args)
	}
	v3 := ScanRequest{SNMP: &SNMP{Start: "10.0.0.1", End: "10.0.0.9", Version: "v3", SecLevel: "authPriv",
		SecName: "nut", AuthProtocol: "SHA256", AuthPassword: "auth secret", PrivProtocol: "AES", PrivPassword: "priv secret"}}
	args, _ = v3.Args()
	if strings.Join(args, " ") != "-S -s 10.0.0.1 -e 10.0.0.9 -l authPriv -u nut -w SHA256 -W auth secret -x AES -X priv secret" {
		t.Fatalf("v3: %v", args)
	}
	for _, bad := range []ScanRequest{
		{},
		{SNMP: &SNMP{Start: "10.0.0.1; rm", End: "10.0.0.9", Version: "v1"}},
		{SNMP: &SNMP{Start: "10.0.0.1", End: "10.0.0.9", Version: "v3", SecLevel: "authNoPriv", SecName: "nut"}},
		{SNMP: &SNMP{Start: "10.0.0.1", End: "10.0.0.9", Version: "v4"}},
	} {
		if _, err := bad.Args(); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestParseScanDropsPasswords(t *testing.T) {
	output := `[nutdev1]
	driver = "usbhid-ups"
	port = "auto"
	vendorid = "0764"
	productid = "0501"
	product = "CP1500PFCLCD"
	serial = "CTHGT2000001"
	vendor = "CPS"
	bus = "001"

[nutdev2]
	driver = "snmp-ups"
	port = "10.0.0.5"
	desc = "APC Smart-UPS"
	mibs = "apcc"
	community = "secret-community"
`
	devices := ParseScan(output)
	if len(devices) != 2 {
		t.Fatalf("got %+v", devices)
	}
	usb := devices[0]
	if usb.Vendor != "CPS" || usb.Product != "CP1500PFCLCD" || usb.Extra["vendorid"] != "0764" || usb.Bus != "001" {
		t.Fatalf("usb: %+v", usb)
	}
	if _, ok := devices[1].Extra["community"]; ok {
		t.Fatal("community returned to the server")
	}
}

func TestApplyWritesConfigWithBackups(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nut")
	os.MkdirAll(conf, 0o755)
	os.WriteFile(filepath.Join(conf, "ups.conf"), []byte("[old]\n\tdriver = blazer_usb\n\tport = auto\n"), 0o640)
	var ran []string
	sys := &System{
		ConfigDirs: []string{conf},
		StateDir:   filepath.Join(dir, "state"),
		Now:        func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) },
		Run: func(_ context.Context, name string, args ...string) (string, error) {
			ran = append(ran, name+" "+strings.Join(args, " "))
			switch {
			case strings.HasSuffix(name, "upsd"):
				return "Network UPS Tools upsd 2.8.1\n", nil
			case name == "systemctl" && args[0] == "show":
				if args[len(args)-1] == "nut-driver-enumerator.service" {
					return "loaded\n", nil
				}
				return "not-found\n", nil
			}
			return "", nil
		},
	}
	result, err := sys.Apply(context.Background(), ApplyRequest{UPS: []Section{rack}, Listen: "192.168.1.5"})
	if err != nil {
		t.Fatal(err)
	}
	// ups.conf, upsd.conf, upsd.users and nut.conf; no upsmon.conf without local shutdown.
	if result.MonitorUser != "wolups" || result.MonitorPassword == "" || len(result.Files) != 4 {
		t.Fatalf("result: %+v", result)
	}
	upsConf, _ := os.ReadFile(filepath.Join(conf, "ups.conf"))
	if !strings.Contains(string(upsConf), "[old]") || !strings.Contains(string(upsConf), "[rack]") {
		t.Fatalf("ups.conf:\n%s", upsConf)
	}
	if _, err := os.Stat(filepath.Join(conf, "ups.conf.wolups-20260102T030405Z")); err != nil {
		t.Fatal("no backup of the original ups.conf")
	}
	if !strings.Contains(strings.Join(ran, "\n"), "systemctl restart nut-driver.target nut-server.service") {
		t.Fatalf("services not restarted: %v", ran)
	}
	// The same request again changes nothing and keeps the passwords.
	again, err := sys.Apply(context.Background(), ApplyRequest{UPS: []Section{rack}, Listen: "192.168.1.5"})
	if err != nil || len(again.Files) != 0 || again.MonitorPassword != result.MonitorPassword {
		t.Fatalf("second apply: %+v %v", again, err)
	}
	if _, err := sys.Apply(context.Background(), ApplyRequest{UPS: []Section{{Name: "Bad"}}, Listen: "192.168.1.5"}); err == nil {
		t.Fatal("invalid section applied")
	}
}
