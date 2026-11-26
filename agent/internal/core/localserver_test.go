package core

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServerAddr(t *testing.T) {
	cases := map[string]string{
		"http://192.168.1.5:4321":     "192.168.1.5:4321",
		"https://wolups.example.com":  "wolups.example.com:443",
		"http://wolups.lan/sub":       "wolups.lan:80",
		"https://wolups.example:8443": "wolups.example:8443",
	}
	for in, want := range cases {
		if got, err := serverAddr(in); err != nil || got != want {
			t.Fatalf("serverAddr(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestIsOwnAddress(t *testing.T) {
	own := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("192.168.1.5")}
	if !isOwnAddress([]net.IP{net.ParseIP("192.168.1.5")}, own) {
		t.Fatal("own LAN address not recognised")
	}
	if isOwnAddress([]net.IP{net.ParseIP("192.168.1.6")}, own) || isOwnAddress([]net.IP{net.ParseIP("127.0.0.1")}, own) {
		t.Fatal("another machine or loopback counted as own address")
	}
	if !isLoopbackHost("localhost") || !isLoopbackHost("127.0.0.1") || isLoopbackHost("192.168.1.5") {
		t.Fatal("loopback host check is wrong")
	}
}

func TestDialServerPrefersLoopback(t *testing.T) {
	var dialed []string
	reachable := map[string]bool{}
	dial := func(_ context.Context, _, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		if !reachable[addr] {
			return nil, errors.New("refused")
		}
		client, server := net.Pipe()
		server.Close()
		return client, nil
	}
	run := func(addr string, local bool) (bool, error) {
		dialed = nil
		conn, loopback, err := dialServer(t.Context(), dial, "tcp", addr, "192.168.1.5:4321", local)
		if conn != nil {
			conn.Close()
		}
		return loopback, err
	}

	reachable["127.0.0.1:4321"] = true
	if loopback, err := run("192.168.1.5:4321", true); err != nil || !loopback || len(dialed) != 1 {
		t.Fatalf("local server not dialed through loopback: %v %v %v", loopback, err, dialed)
	}
	// Without the LAN address, loopback still answers.
	if loopback, err := run("192.168.1.5:4321", false); err == nil || loopback || dialed[0] != "192.168.1.5:4321" {
		t.Fatalf("remote server dialed through loopback: %v %v %v", loopback, err, dialed)
	}
	// A server that only listens on its LAN address is still reached.
	reachable = map[string]bool{"192.168.1.5:4321": true}
	if loopback, err := run("192.168.1.5:4321", true); err != nil || loopback || len(dialed) != 2 {
		t.Fatalf("no fallback to the server address: %v %v %v", loopback, err, dialed)
	}
	// A proxy address is dialed as it is.
	reachable = map[string]bool{"10.0.0.1:3128": true}
	if loopback, err := run("10.0.0.1:3128", true); err != nil || loopback || dialed[0] != "10.0.0.1:3128" {
		t.Fatalf("proxy address rewritten: %v %v %v", loopback, err, dialed)
	}
}

func TestServerLocalIsRemembered(t *testing.T) {
	a, _ := newTestAgent(t, nil)
	a.opts.State.ServerURL = "http://192.0.2.10:4321"
	if a.serverIsLocal(t.Context(), "192.0.2.10:4321") {
		t.Fatal("unknown address counted as local")
	}
	a.setServerLocal(true)
	saved, err := a.opts.Store.Load()
	if err != nil || !saved.ServerLocal {
		t.Fatalf("server location not saved: %v", err)
	}
	// The LAN address may be gone during a network restart, so the saved answer is kept.
	if !a.serverIsLocal(t.Context(), "192.0.2.10:4321") || a.serverIsLocal(t.Context(), "127.0.0.1:4321") {
		t.Fatal("saved server location not used")
	}
	a.setServerLocal(false)
	if saved, _ := a.opts.Store.Load(); saved.ServerLocal {
		t.Fatal("server location not cleared")
	}
}

func TestServerClientUsesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(r.Host))
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	a, _ := newTestAgent(t, nil)
	// The LAN address is gone, but the server was seen on this machine before.
	a.opts.State.ServerURL = "http://192.0.2.10:" + port
	a.opts.State.ServerLocal = true
	loopback := false
	resp, err := a.serverClient(&loopback).Get(a.opts.State.ServerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !loopback || string(body) != "192.0.2.10:"+port {
		t.Fatalf("loopback=%v host=%q", loopback, body)
	}
}
