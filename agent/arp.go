package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"strings"
	"time"
)

const arpTablePath = "/proc/net/arp"

// lookupMAC finds the MAC address for an IPv4 address on one of the agent's own subnets.
// It sends one UDP packet to the discard port so the kernel resolves the address, then
// reads the ARP table. Nothing is executed and the target only receives a single packet.
func lookupMAC(ipValue string) (string, error) {
	ip := net.ParseIP(strings.TrimSpace(ipValue)).To4()
	if ip == nil {
		return "", errors.New("invalid IPv4 address")
	}
	onLink := false
	for _, iface := range collectInterfaces() {
		for _, cidr := range iface.CIDRs {
			own, network, err := net.ParseCIDR(cidr)
			if err != nil {
				continue
			}
			if own.Equal(ip) {
				return iface.MAC, nil
			}
			if network.Contains(ip) {
				onLink = true
			}
		}
	}
	if !onLink {
		return "", errors.New("address is not on a subnet this agent is connected to")
	}
	if mac, ok := readARP(arpTablePath, ip.String()); ok {
		return mac, nil
	}
	if conn, err := net.Dial("udp4", net.JoinHostPort(ip.String(), "9")); err == nil {
		_, _ = conn.Write([]byte{0})
		conn.Close()
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		if mac, ok := readARP(arpTablePath, ip.String()); ok {
			return mac, nil
		}
	}
	return "", errors.New("no ARP reply, the device may be off")
}

// readARP returns the complete hardware address for ip from a /proc/net/arp style table.
func readARP(path, ip string) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// IP address, HW type, Flags, HW address, Mask, Device
		if len(fields) < 4 || fields[0] != ip || fields[2] == "0x0" {
			continue
		}
		mac, err := net.ParseMAC(fields[3])
		if err != nil || mac.String() == "00:00:00:00:00:00" {
			continue
		}
		return mac.String(), true
	}
	return "", false
}
