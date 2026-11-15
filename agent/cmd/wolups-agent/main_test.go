package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMagicPacket(t *testing.T) {
	mac, err := parseMAC("01:23:45:67:89:ab")
	if err != nil {
		t.Fatal(err)
	}
	packet := magicPacket(mac)
	if len(packet) != 102 || !bytes.Equal(packet[:6], bytes.Repeat([]byte{0xff}, 6)) {
		t.Fatal("bad header")
	}
	if !bytes.Equal(packet[96:], mac) {
		t.Fatal("bad payload")
	}
	if _, err := parseMAC("not-a-mac"); err == nil {
		t.Fatal("invalid MAC accepted")
	}
}

func TestReadARP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "arp")
	table := `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.20     0x1         0x2         BC:24:11:4A:9E:01     *        eth0
192.168.1.21     0x1         0x0         00:00:00:00:00:00     *        eth0
`
	if err := os.WriteFile(path, []byte(table), 0o600); err != nil {
		t.Fatal(err)
	}
	if mac, ok := readARP(path, "192.168.1.20"); !ok || mac != "bc:24:11:4a:9e:01" {
		t.Fatalf("got %q %v", mac, ok)
	}
	if _, ok := readARP(path, "192.168.1.21"); ok {
		t.Fatal("incomplete entry returned")
	}
	if _, ok := readARP(path, "192.168.1.99"); ok {
		t.Fatal("missing entry returned")
	}
}

func TestLookupMACRejectsInvalidAndRemote(t *testing.T) {
	if _, err := lookupMAC("not-an-ip"); err == nil {
		t.Fatal("invalid IP accepted")
	}
	if _, err := lookupMAC("203.0.113.7"); err == nil {
		t.Fatal("address outside local subnets accepted")
	}
}

func TestUnitStartsInstalledBinary(t *testing.T) {
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/wolups-agent serve") {
		t.Fatal("unit does not start the installed binary")
	}
	if !strings.Contains(unit, "Before=pve-guests.service\n\n[Service]") {
		t.Fatal("unit lost the Proxmox ordering")
	}
}
