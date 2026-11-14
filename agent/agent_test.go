package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func signedCommand(t *testing.T, key ed25519.PrivateKey, cmd command) (string, string) {
	t.Helper()
	payload, err := json.Marshal(cmd)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(key, []byte(commandMessage(string(payload))))
	return string(payload), base64.RawURLEncoding.EncodeToString(sig)
}

func testKeys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestVerifyCommand(t *testing.T) {
	pub, priv := testKeys(t)
	now := time.Now()
	base := command{V: 1, ID: "c1", AgentID: "a1", Type: "ping", Args: json.RawMessage("{}"),
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Minute).UnixMilli()}

	payload, sig := signedCommand(t, priv, base)
	if _, err := verifyCommand(pub, "a1", payload, sig, now); err != nil {
		t.Fatalf("valid command rejected: %v", err)
	}
	if _, err := verifyCommand(pub, "other", payload, sig, now); err == nil {
		t.Fatal("command for another agent accepted")
	}
	if _, err := verifyCommand(pub, "a1", strings.Replace(payload, "ping", "shutdown", 1), sig, now); err == nil {
		t.Fatal("tampered payload accepted")
	}
	_, otherPriv := testKeys(t)
	forged, forgedSig := signedCommand(t, otherPriv, base)
	if _, err := verifyCommand(pub, "a1", forged, forgedSig, now); err == nil {
		t.Fatal("command signed by another key accepted")
	}
	expired := base
	expired.ExpiresAt = now.Add(-time.Second).UnixMilli()
	payload, sig = signedCommand(t, priv, expired)
	if _, err := verifyCommand(pub, "a1", payload, sig, now); err == nil {
		t.Fatal("expired command accepted")
	}
}

func TestHelloSignatureMatchesServerFormat(t *testing.T) {
	pub, priv := testKeys(t)
	sig := signHello(priv, "agent", "nonce", 123)
	raw, _ := base64.RawURLEncoding.DecodeString(sig)
	if !ed25519.Verify(pub, []byte("wolups-hello:v1\nagent\nnonce\n123"), raw) {
		t.Fatal("hello signature does not verify")
	}
}

func newTestAgent(t *testing.T) (*agent, ed25519.PrivateKey, *[]string) {
	t.Helper()
	pub, priv := testKeys(t)
	_, agentPriv := testKeys(t)
	store := &stateStore{dir: t.TempDir()}
	st := &persistedState{
		ServerURL:       "https://example.com",
		AgentID:         "a1",
		PrivateKey:      base64.RawURLEncoding.EncodeToString(agentPriv.Seed()),
		ServerPublicKey: base64.RawURLEncoding.EncodeToString(pub),
		Processed:       map[string]int64{},
	}
	if err := store.save(st); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	acts := actions{
		poweroff: func() error { calls = append(calls, "poweroff"); return nil },
		wake: func(mac, b string, p int) (int, error) {
			calls = append(calls, "wake:"+mac)
			return 1, nil
		},
		resolve: func(ip string) (string, error) {
			calls = append(calls, "resolve:"+ip)
			return "aa:bb:cc:dd:ee:ff", nil
		},
		update: func() (updateOutcome, error) { return updateOutcome{}, nil },
		exit:   func(int) { calls = append(calls, "exit") },
	}
	a, err := newAgent(store, st, acts)
	if err != nil {
		t.Fatal(err)
	}
	return a, priv, &calls
}

func TestDuplicateCommandRunsOnce(t *testing.T) {
	a, priv, calls := newTestAgent(t)
	now := time.Now()
	cmd := command{V: 1, ID: "wake-1", AgentID: "a1", Type: "wol",
		Args: json.RawMessage(`{"mac":"aa:bb:cc:dd:ee:ff"}`), IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Minute).UnixMilli()}
	payload, sig := signedCommand(t, priv, cmd)
	a.handleCommand(t.Context(), payload, sig)
	a.handleCommand(t.Context(), payload, sig)
	if len(*calls) != 1 {
		t.Fatalf("expected one wake, got %v", *calls)
	}
}

func TestProcessedIsPruned(t *testing.T) {
	values := map[string]int64{}
	for i := 0; i < 10; i++ {
		values[string(rune('a'+i))] = int64(i)
	}
	pruneProcessed(values, 5)
	if len(values) != 5 {
		t.Fatalf("expected 5, got %d", len(values))
	}
	if _, ok := values["a"]; ok {
		t.Fatal("oldest entry was kept")
	}
}

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

func TestIsNewer(t *testing.T) {
	cases := []struct {
		current, candidate string
		want               bool
	}{
		{"1.0.0", "1.0.1", true},
		{"1.2.0", "1.10.0", true},
		{"2.0.0", "1.9.9", false},
		{"1.0.0", "1.0.0", false},
		{"dev", "0.1.0", true},
	}
	for _, c := range cases {
		got, err := isNewer(c.current, c.candidate)
		if err != nil || got != c.want {
			t.Errorf("isNewer(%s, %s) = %v, %v", c.current, c.candidate, got, err)
		}
	}
}

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestUpdateVerifiesChecksum(t *testing.T) {
	manifest := []byte(`{"version":"9.9.9","protocol_version":1}`)
	binary := []byte("new-binary")
	files := map[string][]byte{
		"agent-release.json":              manifest,
		"agent-release.json.sha256":       []byte(sha(manifest) + "  agent-release.json\n"),
		"wolups-agent-linux-amd64":        binary,
		"wolups-agent-linux-amd64.sha256": []byte(sha([]byte("something else")) + "  wolups-agent-linux-amd64\n"),
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := files[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "wolups-agent")
	os.WriteFile(target, []byte("old"), 0o755)
	u := &updater{releaseBase: srv.URL, binaryPath: target, arch: "amd64", client: srv.Client(),
		verify: func(string, string) error { return nil }}

	if _, err := u.run("1.0.0"); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("expected checksum error, got %v", err)
	}
	files["wolups-agent-linux-amd64.sha256"] = []byte(sha(binary) + "  wolups-agent-linux-amd64\n")
	out, err := u.run("1.0.0")
	if err != nil || !out.Updated {
		t.Fatalf("update failed: %+v %v", out, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new-binary" {
		t.Fatalf("binary not replaced: %q", got)
	}
	out, err = u.run("9.9.9")
	if err != nil || out.Updated {
		t.Fatalf("expected no update on same version: %+v %v", out, err)
	}
}

func TestServerURLValidation(t *testing.T) {
	if _, err := validateServerURL("http://x.lan", false); err == nil {
		t.Fatal("http accepted without --allow-http")
	}
	if _, err := validateServerURL("http://x.lan", true); err != nil {
		t.Fatal(err)
	}
	if got, _ := validateServerURL("https://x.example.com/", false); got != "https://x.example.com" {
		t.Fatalf("got %s", got)
	}
	if u, _ := websocketURL("https://x.example.com/sub"); u != "wss://x.example.com/sub/api/agents/ws" {
		t.Fatalf("got %s", u)
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

func TestRepeatLogThrottles(t *testing.T) {
	now := time.Unix(0, 0)
	r := newRepeatLog(time.Hour)
	r.now = func() time.Time { return now }
	if !r.Print("down") {
		t.Fatal("first message not logged")
	}
	for i := 0; i < 100; i++ {
		now = now.Add(time.Minute / 2)
		if r.Print("down") {
			t.Fatalf("repeat %d logged inside the interval", i)
		}
	}
	now = now.Add(time.Hour)
	if !r.Print("down") {
		t.Fatal("summary not logged after the interval")
	}
	if !r.Print("other error") {
		t.Fatal("new message not logged")
	}
}
