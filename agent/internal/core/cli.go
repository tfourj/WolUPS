package core

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// BuildOptions returns the agent options for a paired state. Store and State are filled in by Main.
type BuildOptions func(st *PersistedState) Options

// Main runs the shared command line: version, enroll, serve, status, reset and install-unit.
func Main(c Component, description string, build BuildOptions) {
	log.SetFlags(0)
	usage := fmt.Sprintf(`%[1]s: %[2]s

Usage:
  %[1]s enroll --server URL --token TOKEN [--release-base URL] [--allow-http]
  %[1]s serve
  %[1]s status
  %[1]s reset --confirm
  %[1]s install-unit
  %[1]s version
`, c.Name, description)
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	stateDir := os.Getenv("WOLUPS_AGENT_STATE_DIR")
	if stateDir == "" {
		stateDir = c.StateDir
	}
	store := &StateStore{Dir: stateDir}

	var err error
	switch os.Args[1] {
	case "version":
		fmt.Println(c.VersionLine(c.Version))
	case "enroll":
		err = runEnroll(c, store, os.Args[2:])
	case "serve":
		err = runServe(c, store, build)
	case "status":
		err = runStatus(c, store)
	case "reset":
		err = runReset(store, os.Args[2:])
	case "install-unit":
		err = InstallUnit(c)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func validateServerURL(value string, allowHTTP bool) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(value), "/")
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" {
		return "", errors.New("server must be a URL like https://wolups.example.com")
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http") {
		return "", errors.New("server must use https (pass --allow-http only on a trusted LAN)")
	}
	return trimmed, nil
}

type enrollResponse struct {
	AgentID         string `json:"agentId"`
	DeviceName      string `json:"deviceName"`
	ServerPublicKey string `json:"serverPublicKey"`
	Error           string `json:"error"`
}

func runEnroll(c Component, store *StateStore, args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	server := fs.String("server", "", "WolUPS base URL")
	token := fs.String("token", "", "one-time enrollment token")
	releaseBase := fs.String("release-base", DefaultReleaseBase,
		"GitHub releases page, or an HTTPS directory with one release")
	allowHTTP := fs.Bool("allow-http", false, "allow a plain http server URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	serverURL, err := validateServerURL(*server, *allowHTTP)
	if err != nil {
		return err
	}
	base, err := validateReleaseBase(*releaseBase)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*token) == "" {
		return errors.New("--token is required")
	}

	// Reuse the key from a previous attempt so a retry with the same token is accepted.
	seed := make([]byte, ed25519.SeedSize)
	pending := filepath.Join(store.Dir, "pending-key")
	if data, err := os.ReadFile(pending); err == nil && len(data) == ed25519.SeedSize {
		copy(seed, data)
	} else {
		if _, err := rand.Read(seed); err != nil {
			return err
		}
		if err := os.MkdirAll(store.Dir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(pending, seed, 0o600); err != nil {
			return err
		}
	}
	key := ed25519.NewKeyFromSeed(seed)
	public := key.Public().(ed25519.PublicKey)

	body, _ := json.Marshal(map[string]any{
		"token":     strings.TrimSpace(*token),
		"publicKey": base64.RawURLEncoding.EncodeToString(public),
		"info":      CurrentInfo(c.Version),
	})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(serverURL+"/api/agents/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("could not reach WolUPS at %s: %w", serverURL, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var result enrollResponse
	_ = json.Unmarshal(data, &result)
	if resp.StatusCode != http.StatusOK {
		if result.Error == "" {
			result.Error = resp.Status
		}
		return fmt.Errorf("enrollment rejected: %s", result.Error)
	}
	if result.AgentID == "" || result.ServerPublicKey == "" {
		return errors.New("enrollment response is incomplete")
	}
	st := &PersistedState{
		ServerURL:       serverURL,
		AgentID:         result.AgentID,
		PrivateKey:      base64.RawURLEncoding.EncodeToString(seed),
		ServerPublicKey: result.ServerPublicKey,
		ReleaseBase:     base,
		DeviceName:      result.DeviceName,
		EnrolledAt:      time.Now().UnixMilli(),
		Processed:       map[string]int64{},
	}
	if _, err := st.serverKey(); err != nil {
		return err
	}
	if err := store.Save(st); err != nil {
		return err
	}
	_ = os.Remove(pending)
	fmt.Printf("Paired with WolUPS as %q\n", result.DeviceName)
	return nil
}

func runServe(c Component, store *StateStore, build BuildOptions) error {
	st, err := store.Load()
	if errors.Is(err, ErrNotPaired) {
		log.Print("agent is not paired. Run the install command from the WolUPS UI.")
		return nil
	}
	if err != nil {
		return err
	}
	if repairUnit(c) {
		// Non-zero exit makes systemd (Restart=on-failure) start the agent again under the new file.
		os.Exit(75)
	}
	binaryPath, err := os.Executable()
	if err != nil {
		return err
	}
	opts := build(st)
	opts.Component = c
	opts.Component.BinaryPath = binaryPath
	opts.Store = store
	opts.State = st
	a, err := NewAgent(opts)
	if err != nil {
		return err
	}
	log.Printf("%s %s starting", c.Name, c.Version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	a.Run(ctx)
	return nil
}

func runStatus(c Component, store *StateStore) error {
	st, err := store.Load()
	if errors.Is(err, ErrNotPaired) {
		fmt.Println("Not paired")
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Printf("Version:  %s\nServer:   %s\nName:     %s\nAgent ID: %s\nPaired:   %s\n",
		c.Version, st.ServerURL, st.DeviceName, st.AgentID, time.UnixMilli(st.EnrolledAt).Format(time.RFC3339))
	return nil
}

func runReset(store *StateStore, args []string) error {
	if len(args) == 0 || args[0] != "--confirm" {
		return errors.New("this removes the pairing; run again with --confirm")
	}
	if err := store.Remove(); err != nil {
		return err
	}
	fmt.Println("Pairing removed. Stop the service or pair again from the WolUPS UI.")
	return nil
}
