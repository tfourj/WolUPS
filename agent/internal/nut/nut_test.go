package nut

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var rack = Section{Name: "rack", Driver: "usbhid-ups", Port: "auto", Desc: "Rack UPS",
	Extra: map[string]string{"vendorid": "0764", "productid": "0501"}}

func TestRenderUpsConfFresh(t *testing.T) {
	got, err := RenderUpsConf("", UpsConfChange{Upsert: []Section{rack}})
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
	snmp := Section{Name: "snmp", Driver: "snmp-ups", Port: "10.0.0.5", Extra: map[string]string{"community": "s3cret-c"}}
	first, err := RenderUpsConf(existing, UpsConfChange{Upsert: []Section{rack, snmp}})
	if err != nil {
		t.Fatal(err)
	}
	// Adding another UPS keeps the managed ones, passwords included.
	second, err := RenderUpsConf(first, UpsConfChange{Upsert: []Section{{Name: "spare", Driver: "usbhid-ups", Port: "auto"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(second, existing) || !strings.Contains(second, "[rack]") || !strings.Contains(second, "[spare]") ||
		!strings.Contains(second, `community = "s3cret-c"`) {
		t.Fatalf("block not merged:\n%s", second)
	}
	if strings.Count(second, blockBegin) != 1 {
		t.Fatal("block duplicated")
	}
	replaced, _ := RenderUpsConf(second, UpsConfChange{
		Upsert: []Section{{Name: "rack", Driver: "usbhid-ups", Port: "auto", Desc: "New"}},
		Remove: []string{"spare"},
	})
	if names := ManagedSections(replaced); len(names) != 2 || names[0].Desc != "New" || names[1].Name != "snmp" {
		t.Fatalf("replace and remove: %+v", names)
	}
	empty, _ := RenderUpsConf(replaced, UpsConfChange{Remove: []string{"rack", "snmp"}})
	if empty != existing {
		t.Fatalf("removing every managed UPS should leave the original file, got:\n%q", empty)
	}
	if _, err := RenderUpsConf(existing, UpsConfChange{Upsert: []Section{{Name: "old", Driver: "usbhid-ups", Port: "auto"}}}); err == nil {
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

func TestMigrateKeepsSectionsAsWritten(t *testing.T) {
	existing := "maxretry = 3\n\n[old]\n\tdriver = blazer_usb\n\tport = auto\n\tnolock\n\toverride.battery.charge.low = 20\n" +
		"\n[snmp]\n\tdriver = snmp-ups\n\tport = 10.0.0.5\n\tcommunity = s3cret-c\n"
	got, err := RenderUpsConf(existing, UpsConfChange{Migrate: []string{"old"}})
	if err != nil {
		t.Fatal(err)
	}
	outside := outsideBlock(got)
	if strings.Contains(outside, "[old]") || !strings.Contains(outside, "[snmp]") || !strings.HasPrefix(outside, "maxretry = 3") {
		t.Fatalf("outside block:\n%s", outside)
	}
	block := blockText(got)
	if !strings.Contains(block, "\tnolock\n") || !strings.Contains(block, "override.battery.charge.low = 20") {
		t.Fatalf("migrated section changed:\n%s", block)
	}
	// Later changes keep the migrated section as written.
	again, err := RenderUpsConf(got, UpsConfChange{Upsert: []Section{rack}})
	if err != nil || !strings.Contains(blockText(again), "\tnolock\n") || !strings.Contains(blockText(again), "[rack]") {
		t.Fatalf("migrated section lost on the next apply: %v\n%s", err, again)
	}
	if _, err := RenderUpsConf(existing, UpsConfChange{Migrate: []string{"missing"}}); err == nil {
		t.Fatal("migrating an unknown section accepted")
	}
}

func TestListenSkipsAddressesAlreadyServed(t *testing.T) {
	cases := map[string]string{
		"":                                   "LISTEN 127.0.0.1 3493\nLISTEN 192.168.1.5 3493\n",
		"LISTEN 127.0.0.1 3493\n":            "LISTEN 192.168.1.5 3493\n",
		"LISTEN 192.168.1.5\n":               "LISTEN 127.0.0.1 3493\n",
		"LISTEN 0.0.0.0 3493\n":              "",
		"LISTEN :: 3493\n":                   "",
		"LISTEN 192.168.1.5 3494\n":          "LISTEN 127.0.0.1 3493\nLISTEN 192.168.1.5 3493\n",
		"# LISTEN 0.0.0.0 3493\nMAXAGE 15\n": "LISTEN 127.0.0.1 3493\nLISTEN 192.168.1.5 3493\n",
	}
	for current, want := range cases {
		got, err := RenderUpsdConf(current, "192.168.1.5")
		if err != nil {
			t.Fatal(err)
		}
		if body := strings.TrimPrefix(blockText(got), "\n# Written by wolups-nut-agent. Changes inside this block are replaced.\n"); body != want {
			t.Errorf("existing %q: block %q, want %q", current, body, want)
		}
	}
}

func TestMaskSecrets(t *testing.T) {
	text := "[admin]\n\tpassword = hunter2\nMONITOR rack@localhost 1 admin hunter2 primary\n\tcommunity = \"c0mm\"\n"
	masked := MaskSecrets(text)
	if strings.Contains(masked, "hunter2") || strings.Contains(masked, "c0mm") {
		t.Fatalf("secrets left: %s", masked)
	}
	if !strings.Contains(masked, "MONITOR rack@localhost 1 admin *** primary") {
		t.Fatalf("monitor line: %s", masked)
	}
}

func TestDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	original := "[old]\n\tdriver = blazer_usb\n\tport = auto\n"
	os.WriteFile(filepath.Join(dir, "ups.conf"), []byte(original), 0o640)
	sys := &System{ConfigDirs: []string{dir}, StateDir: filepath.Join(dir, "state"), Now: time.Now,
		Run: func(_ context.Context, name string, _ ...string) (string, error) {
			if strings.HasSuffix(name, "upsd") {
				return "Network UPS Tools upsd 2.8.1", nil
			}
			t.Fatalf("dry run ran %s", name)
			return "", nil
		}}
	result, err := sys.Apply(context.Background(), ApplyRequest{Migrate: []string{"old"}, Listen: "192.168.1.5", DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Changes) != 4 || result.MonitorPassword != "" {
		t.Fatalf("result: %+v", result)
	}
	for _, change := range result.Changes {
		if strings.Contains(change.After, "password = \"") && !strings.Contains(change.After, "password = ***") {
			t.Fatalf("%s leaks a password", change.Path)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "ups.conf")); string(data) != original {
		t.Fatal("dry run wrote ups.conf")
	}
	if _, err := os.Stat(filepath.Join(dir, "upsd.conf")); err == nil {
		t.Fatal("dry run created upsd.conf")
	}
}

func TestReadExistingConfig(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "nut.conf"), []byte("MODE=standalone\n"), 0o640)
	os.WriteFile(filepath.Join(dir, "upsd.conf"), []byte("LISTEN 0.0.0.0 3493\n"), 0o640)
	os.WriteFile(filepath.Join(dir, "upsd.users"), []byte("[monuser]\n\tpassword = secret\n\tupsmon primary\n"), 0o640)
	os.WriteFile(filepath.Join(dir, "upsmon.conf"), []byte("MONITOR old@localhost 1 monuser secret primary\n"), 0o640)
	cfg := readExisting(dir)
	if cfg.Mode != "standalone" || strings.Join(cfg.Listen, ",") != "0.0.0.0" ||
		strings.Join(cfg.Users, ",") != "monuser" || strings.Join(cfg.Monitors, ",") != "old@localhost as monuser (primary)" {
		t.Fatalf("got %+v", cfg)
	}
}

func TestEditPatchesManagedSectionInPlace(t *testing.T) {
	current, _ := RenderUpsConf("", UpsConfChange{Upsert: []Section{
		{Name: "ups1", Driver: "usbhid-ups", Port: "auto", Desc: "Old", Extra: map[string]string{"serial": "AAA"}},
		{Name: "snmp", Driver: "snmp-ups", Port: "10.0.0.5", Extra: map[string]string{"community": "s3cret-c"}},
	}})
	// A flag line WolUPS does not know must survive.
	current = strings.Replace(current, "[ups1]\n", "[ups1]\n\tnolock\n", 1)
	got, err := RenderUpsConf(current, UpsConfChange{Edit: []SectionEdit{
		{Name: "ups1", Set: map[string]string{"desc": "Rack A", "serial": "BBB"}},
		{Name: "snmp", Set: map[string]string{"port": "10.0.0.6", "desc": ""}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"\tnolock\n", `desc = "Rack A"`, `serial = "BBB"`, `port = "10.0.0.6"`, `community = "s3cret-c"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "AAA") || strings.Contains(got, `desc = "Old"`) {
		t.Fatalf("old values left:\n%s", got)
	}
	for _, bad := range []SectionEdit{
		{Name: "ups1", Set: map[string]string{"driver": "x"}},
		{Name: "ups1", Set: map[string]string{"port": ""}},
		{Name: "ups1", Set: map[string]string{"desc": `say "hi"`}},
		{Name: "missing", Set: map[string]string{"desc": "x"}},
	} {
		if _, err := RenderUpsConf(current, UpsConfChange{Edit: []SectionEdit{bad}}); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestUpsmonMonitorsAndToggle(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "upsmon.conf"), []byte("MONITOR powerwalker-1@nut.local 1 mon pw primary\n"+
		"MONITOR ups@127.0.0.1:1 1 mon pw slave\nMONITOR rack@resolves.example 1 mon pw slave\n"), 0o640)
	journal := ""
	var ran []string
	sys := &System{ConfigDirs: []string{dir}, StateDir: filepath.Join(dir, "state"), Now: time.Now,
		Run: func(_ context.Context, name string, args ...string) (string, error) {
			switch name {
			case "getent":
				// Like Raspberry Pi OS: .local goes to mDNS only, so it does not resolve even if DNS would.
				if args[1] == "resolves.example" {
					return "127.0.0.1 STREAM resolves.example\n", nil
				}
				return "", errors.New("exit status 2")
			case "journalctl":
				return journal, nil
			}
			ran = append(ran, name+" "+strings.Join(args, " "))
			return "", nil
		}}
	ctx := context.Background()
	monitors := sys.monitors(ctx)
	if len(monitors) != 3 || monitors[0].Reachable || monitors[0].Error != "no such host" ||
		monitors[1].Reachable || monitors[1].Error != "cannot connect" || monitors[2].Error != "cannot connect" {
		t.Fatalf("monitors: %+v", monitors)
	}
	// What upsmon logged wins: a target it keeps failing to reach is unreachable, with its reason.
	journal = "UPS [rack@resolves.example]: connect failed: Connection refused\n" +
		"Login on UPS [ups@127.0.0.1:1] failed - got [ERR ACCESS-DENIED]\n"
	monitors = sys.monitors(ctx)
	if monitors[2].Error != "connection refused" || monitors[1].Error != "login failed" {
		t.Fatalf("monitors from the journal: %+v", monitors)
	}

	acc, _ := sys.LoadAccounts()
	acc.LocalShutdown = true
	sys.SaveAccounts(acc)
	if err := sys.SetUpsmon(ctx, false); err != nil {
		t.Fatal(err)
	}
	if after, _ := sys.LoadAccounts(); after.LocalShutdown {
		t.Fatal("turning upsmon off kept local shutdown on")
	}
	if err := sys.SetUpsmon(ctx, true); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ran, "\n"); got != "systemctl disable --now nut-monitor.service\nsystemctl enable --now nut-monitor.service" {
		t.Fatalf("ran:\n%s", got)
	}
	os.WriteFile(filepath.Join(dir, "upsmon.conf"), []byte("# nothing\n"), 0o640)
	if err := sys.SetUpsmon(ctx, true); err == nil {
		t.Fatal("turned upsmon on without MONITOR lines")
	}
}
