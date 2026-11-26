package core

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"
)

// When the server URL points at this machine, the agent connects through 127.0.0.1 on the same port, so a network
// restart that drops the LAN address does not cut it off. The URL is unchanged, so TLS and the Host header still use
// its name.

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// serverAddr is the host:port the server URL points at.
func serverAddr(serverURL string) (string, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	return net.JoinHostPort(u.Hostname(), port), nil
}

// isLoopbackHost reports whether a host already names this machine's loopback.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isOwnAddress reports whether any resolved server address belongs to this machine.
func isOwnAddress(resolved, own []net.IP) bool {
	for _, ip := range resolved {
		if ip.IsLoopback() {
			continue
		}
		for _, mine := range own {
			if ip.Equal(mine) {
				return true
			}
		}
	}
	return false
}

func ownAddresses() []net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok {
			ips = append(ips, ipNet.IP)
		}
	}
	return ips
}

// dialServer dials the server address. When the server is local it tries 127.0.0.1 on the same port first and falls
// back to the address itself. loopback reports which one answered. Other addresses, such as a proxy, are dialed as
// they are.
func dialServer(ctx context.Context, dial dialFunc, network, addr, server string, local bool) (net.Conn, bool, error) {
	if !local || addr != server {
		conn, err := dial(ctx, network, addr)
		return conn, false, err
	}
	_, port, err := net.SplitHostPort(addr)
	if err == nil {
		if conn, err := dial(ctx, network, net.JoinHostPort("127.0.0.1", port)); err == nil {
			return conn, true, nil
		}
	}
	conn, err := dial(ctx, network, addr)
	return conn, false, err
}

// serverIsLocal checks whether the server URL resolves to one of this machine's addresses. Once it has, the answer
// is kept until the server is reached on its own address but not on 127.0.0.1, because a network restart can drop
// the LAN address for a while.
func (a *Agent) serverIsLocal(ctx context.Context, server string) bool {
	host, _, err := net.SplitHostPort(server)
	if err != nil || isLoopbackHost(host) {
		return false
	}
	if a.opts.State.ServerLocal {
		return true
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(lookupCtx, host)
	if err != nil {
		return false
	}
	resolved := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		resolved = append(resolved, addr.IP)
	}
	if !isOwnAddress(resolved, ownAddresses()) {
		return false
	}
	a.setServerLocal(true)
	return true
}

func (a *Agent) setServerLocal(local bool) {
	if a.opts.State.ServerLocal == local {
		return
	}
	a.opts.State.ServerLocal = local
	if local {
		log.Print("the server runs on this machine, connecting through 127.0.0.1")
	} else {
		log.Print("the server is not reachable through 127.0.0.1, connecting to its address")
	}
	if a.opts.Store != nil {
		if err := a.opts.Store.setServerLocal(local); err != nil {
			log.Printf("could not save the server location: %v", err)
		}
	}
}

// serverClient is the HTTP client for the WebSocket handshake. It reports whether the last dial used 127.0.0.1.
func (a *Agent) serverClient(loopback *bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		server, err := serverAddr(a.opts.State.ServerURL)
		if err != nil {
			return dialer.DialContext(ctx, network, addr)
		}
		local := addr == server && a.serverIsLocal(ctx, server)
		conn, viaLoopback, err := dialServer(ctx, dialer.DialContext, network, addr, server, local)
		if err == nil && local && !viaLoopback {
			a.setServerLocal(false)
		}
		*loopback = viaLoopback
		return conn, err
	}
	return &http.Client{Transport: transport}
}
