package core

import (
	"net"
	"os"
	"runtime"
)

// CollectInterfaces lists up, non-loopback interfaces with their IPv4 networks.
func CollectInterfaces() []InterfaceInfo {
	list, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []InterfaceInfo{}
	for _, iface := range list {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 || len(iface.HardwareAddr) == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		info := InterfaceInfo{Name: iface.Name, MAC: iface.HardwareAddr.String(), CIDRs: []string{}}
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok && ipNet.IP.To4() != nil {
				info.CIDRs = append(info.CIDRs, ipNet.String())
			}
		}
		if len(info.CIDRs) > 0 {
			out = append(out, info)
		}
		if len(out) >= 32 {
			break
		}
	}
	return out
}

// CurrentInfo describes this machine for hello and status messages.
func CurrentInfo(version string) AgentInfo {
	hostname, _ := os.Hostname()
	return AgentInfo{
		Version:    version,
		Protocol:   ProtocolVersion,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		Hostname:   hostname,
		Interfaces: CollectInterfaces(),
	}
}
