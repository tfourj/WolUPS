package main

import (
	"net"
	"os"
	"runtime"
)

func collectInterfaces() []interfaceInfo {
	list, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []interfaceInfo{}
	for _, iface := range list {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 || len(iface.HardwareAddr) == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		info := interfaceInfo{Name: iface.Name, MAC: iface.HardwareAddr.String(), CIDRs: []string{}}
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

func currentInfo() agentInfo {
	hostname, _ := os.Hostname()
	return agentInfo{
		Version:    version,
		Protocol:   protocolVersion,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		Hostname:   hostname,
		Interfaces: collectInterfaces(),
	}
}
