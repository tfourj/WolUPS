package main

import (
	"strings"
	"testing"

	"github.com/tfourj/WolUPS/agent/internal/nut"
)

func TestUnitCanWriteNUTConfig(t *testing.T) {
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/wolups-nut-agent serve") {
		t.Fatal("unit does not start the installed binary")
	}
	if !strings.Contains(unit, "ReadWritePaths=/var/lib/wolups-nut-agent /usr/local/bin -/etc/nut -/etc/ups") {
		t.Fatal("unit cannot write the NUT config")
	}
	if strings.Contains(unit, "pve-guests") {
		t.Fatal("NUT agent must not order itself before Proxmox guests")
	}
}

func TestComponentNames(t *testing.T) {
	c := component()
	if asset, _ := c.Asset("arm"); asset != "wolups-nut-agent-linux-armv7" {
		t.Fatalf("got %s", asset)
	}
	if c.TagPrefix != "nut-agent-v" || c.Manifest != "nut-agent-release.json" {
		t.Fatalf("release names: %+v", c)
	}
}

func TestSNMPSettingsCarryNoPasswords(t *testing.T) {
	d := nut.Device{Driver: "snmp-ups", Port: "10.0.0.5"}
	addSNMPSettings(&d, nut.SNMP{Version: "v3", SecLevel: "authPriv", SecName: "nut", AuthProtocol: "SHA",
		AuthPassword: "auth secret", PrivProtocol: "AES", PrivPassword: "priv secret"})
	for key, value := range d.Extra {
		if strings.Contains(value, "secret") {
			t.Fatalf("%s carries a password", key)
		}
	}
	if d.Extra["secLevel"] != "authPriv" || d.Extra["authProtocol"] != "SHA" {
		t.Fatalf("settings missing: %v", d.Extra)
	}
}
