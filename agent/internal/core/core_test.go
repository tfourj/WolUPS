package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func signedCommand(t *testing.T, key ed25519.PrivateKey, cmd Command) (string, string) {
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
	base := Command{V: 1, ID: "c1", AgentID: "a1", Type: "ping", Args: json.RawMessage("{}"),
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

var testComponent = Component{
	Name:      "wolups-agent",
	Version:   "1.0.0",
	TagPrefix: "agent-v",
	Manifest:  "agent-release.json",
	Arches:    map[string]string{"amd64": "amd64", "arm64": "arm64", "arm": "armv7"},
}

func newTestAgent(t *testing.T, handlers map[string]Handler) (*Agent, ed25519.PrivateKey) {
	t.Helper()
	pub, priv := testKeys(t)
	_, agentPriv := testKeys(t)
	store := &StateStore{Dir: t.TempDir()}
	st := &PersistedState{
		ServerURL:       "https://example.com",
		AgentID:         "a1",
		PrivateKey:      base64.RawURLEncoding.EncodeToString(agentPriv.Seed()),
		ServerPublicKey: base64.RawURLEncoding.EncodeToString(pub),
		Processed:       map[string]int64{},
	}
	if err := store.Save(st); err != nil {
		t.Fatal(err)
	}
	a, err := NewAgent(Options{Component: testComponent, Store: store, State: st, Handlers: handlers,
		Exit: func(int) {}})
	if err != nil {
		t.Fatal(err)
	}
	return a, priv
}

func TestDuplicateCommandRunsOnce(t *testing.T) {
	runs := 0
	a, priv := newTestAgent(t, map[string]Handler{
		"wol": {Run: func(context.Context, json.RawMessage, *Output) (Reply, error) { runs++; return Reply{}, nil }},
	})
	now := time.Now()
	cmd := Command{V: 1, ID: "wake-1", AgentID: "a1", Type: "wol", Args: json.RawMessage(`{"mac":"aa:bb:cc:dd:ee:ff"}`),
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Minute).UnixMilli()}
	payload, sig := signedCommand(t, priv, cmd)
	a.handleCommand(t.Context(), payload, sig)
	a.handleCommand(t.Context(), payload, sig)
	if runs != 1 {
		t.Fatalf("expected one run, got %d", runs)
	}
}

func TestOutputBatchesAndMasks(t *testing.T) {
	var sent []progressMsg
	out := newOutput("c1", func(v any) error { sent = append(sent, v.(progressMsg)); return nil })
	out.Mask("s3cret")
	for i := 0; i < maxBatchLines+1; i++ {
		out.Line("auth s3cret ok")
	}
	if len(sent) != 1 || len(sent[0].Lines) != maxBatchLines {
		t.Fatalf("expected one full batch, got %+v", sent)
	}
	out.Flush()
	if len(sent) != 2 || len(sent[1].Lines) != 1 || sent[1].Lines[0] != "auth *** ok" {
		t.Fatalf("expected the rest masked, got %+v", sent)
	}
	out.Line(strings.Repeat("x", maxLineLength+10))
	out.Flush()
	if len(sent[2].Lines[0]) != maxLineLength {
		t.Fatal("long line not cut")
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
	u := &updater{component: testComponent, releaseBase: srv.URL, binaryPath: target, arch: "amd64",
		client: srv.Client(), verify: func(string, string) error { return nil }}

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

func TestNewestTag(t *testing.T) {
	tag, err := newestTag([]githubRelease{
		{TagName: "v0.9.0"},
		{TagName: "agent-v0.1.3"},
		{TagName: "agent-v0.1.10"},
		{TagName: "agent-v0.2.0", Prerelease: true},
		{TagName: "agent-v0.3.0", Draft: true},
		{TagName: "agent-v0.4.0-rc.1"},
		{TagName: "nut-agent-v9.0.0"},
	}, "agent-v")
	if err != nil || tag != "agent-v0.1.10" {
		t.Fatalf("got %q %v", tag, err)
	}
	if _, err := newestTag([]githubRelease{{TagName: "v1.0.0"}}, "agent-v"); err == nil {
		t.Fatal("server release accepted as agent release")
	}
}

func TestUpdateFromGitHubReleases(t *testing.T) {
	manifest := []byte(`{"version":"0.2.0","protocol_version":1}`)
	binary := []byte("agent-0.2.0")
	dir := "/o/r/releases/download/agent-v0.2.0/"
	files := map[string][]byte{
		"/repos/o/r/releases": []byte(`[{"tag_name":"v9.0.0"},{"tag_name":"agent-v0.2.0"},` +
			`{"tag_name":"agent-v0.1.3"}]`),
		dir + "agent-release.json":              manifest,
		dir + "agent-release.json.sha256":       []byte(sha(manifest) + "  agent-release.json\n"),
		dir + "wolups-agent-linux-arm64":        binary,
		dir + "wolups-agent-linux-arm64.sha256": []byte(sha(binary) + "  wolups-agent-linux-arm64\n"),
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	}))
	defer srv.Close()

	// Both the current default and the address saved by older agents use the GitHub lookup.
	for _, base := range []string{"https://github.com/o/r/releases", "https://github.com/o/r/releases/latest/download"} {
		target := filepath.Join(t.TempDir(), "wolups-agent")
		os.WriteFile(target, []byte("old"), 0o755)
		u := &updater{component: testComponent, releaseBase: base, binaryPath: target, arch: "arm64",
			client: srv.Client(), apiURL: srv.URL, webURL: srv.URL, verify: func(string, string) error { return nil }}
		out, err := u.run("0.1.3")
		if err != nil || !out.Updated || out.LatestVersion != "0.2.0" {
			t.Fatalf("%s: update failed: %+v %v", base, out, err)
		}
		if got, _ := os.ReadFile(target); string(got) != "agent-0.2.0" {
			t.Fatalf("%s: binary not replaced: %q", base, got)
		}
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

func TestWriteUnitOnlyWhenChanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wolups-agent.service")
	os.WriteFile(path, []byte("[Service]\nExecStart=/old\n"), 0o644)
	reloads := 0
	reload := func() error { reloads++; return nil }
	content := fmt.Sprintf(UnitTemplate, "WolUPS agent", "/usr/local/bin/wolups-agent", "", "/var/lib/x", "64M", "128M")

	changed, err := writeUnit(path, content, reload)
	if err != nil || !changed || reloads != 1 || !unitUpToDate(path, content) {
		t.Fatalf("first write: changed=%v err=%v reloads=%d", changed, err, reloads)
	}
	changed, err = writeUnit(path, content, reload)
	if err != nil || changed || reloads != 1 {
		t.Fatalf("second write should be a no-op: changed=%v err=%v reloads=%d", changed, err, reloads)
	}
}

func TestComponentAssets(t *testing.T) {
	if asset, _ := testComponent.Asset("arm"); asset != "wolups-agent-linux-armv7" {
		t.Fatalf("got %s", asset)
	}
	if _, err := testComponent.Asset("386"); err == nil {
		t.Fatal("unsupported architecture accepted")
	}
	if line := testComponent.VersionLine("1.2.3"); line != "wolups-agent 1.2.3 protocol v1" {
		t.Fatalf("got %s", line)
	}
}
