package main

import (
	"errors"
	"net"
	"strconv"
	"strings"
)

func magicPacket(mac net.HardwareAddr) []byte {
	packet := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		packet = append(packet, 0xff)
	}
	for i := 0; i < 16; i++ {
		packet = append(packet, mac...)
	}
	return packet
}

func parseMAC(value string) (net.HardwareAddr, error) {
	mac, err := net.ParseMAC(strings.TrimSpace(value))
	if err != nil || len(mac) != 6 {
		return nil, errors.New("invalid MAC address")
	}
	return mac, nil
}

// broadcastAddrs returns the directed broadcast address of each IPv4 network the agent sits on.
func broadcastAddrs() []string {
	out := []string{}
	for _, iface := range collectInterfaces() {
		for _, cidr := range iface.CIDRs {
			ip, network, err := net.ParseCIDR(cidr)
			if err != nil || ip.To4() == nil {
				continue
			}
			bcast := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				bcast[i] = network.IP.To4()[i] | ^network.Mask[i]
			}
			out = append(out, bcast.String())
		}
	}
	return out
}

// sendWake sends a magic packet to the given broadcast address, or to every local subnet when empty.
func sendWake(macValue, broadcast string, port int) (int, error) {
	mac, err := parseMAC(macValue)
	if err != nil {
		return 0, err
	}
	if port <= 0 || port > 65535 {
		port = 9
	}
	targets := []string{"255.255.255.255"}
	if broadcast != "" {
		if ip := net.ParseIP(broadcast); ip == nil || ip.To4() == nil {
			return 0, errors.New("invalid broadcast address")
		}
		targets = []string{broadcast}
	} else {
		targets = append(targets, broadcastAddrs()...)
	}
	packet := magicPacket(mac)
	sent := 0
	var lastErr error
	for _, target := range targets {
		conn, err := net.Dial("udp4", net.JoinHostPort(target, strconv.Itoa(port)))
		if err != nil {
			lastErr = err
			continue
		}
		if _, err := conn.Write(packet); err != nil {
			lastErr = err
		} else {
			sent++
		}
		conn.Close()
	}
	if sent == 0 {
		if lastErr == nil {
			lastErr = errors.New("no broadcast target")
		}
		return 0, lastErr
	}
	return sent, nil
}
