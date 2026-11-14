package main

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
	"strings"
	"syscall"
	"time"
)

var version = "dev"

const usage = `wolups-agent: UPS shutdown and wake agent for WolUPS

Usage:
  wolups-agent enroll --server URL --token TOKEN [--release-base URL] [--allow-http]
  wolups-agent serve
  wolups-agent status
  wolups-agent reset --confirm
  wolups-agent install-unit
  wolups-agent version
`

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	stateDir := os.Getenv("WOLUPS_AGENT_STATE_DIR")
	if stateDir == "" {
		stateDir = defaultStateDir
	}
	store := &stateStore{dir: stateDir}

	var err error
	switch os.Args[1] {
	case "version":
		fmt.Printf("wolups-agent %s protocol v%d\n", version, protocolVersion)
	case "enroll":
		err = runEnroll(store, os.Args[2:])
	case "serve":
		err = runServe(store)
	case "status":
		err = runStatus(store)
	case "reset":
		err = runReset(store, os.Args[2:])
	case "install-unit":
		err = runInstallUnit()
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

func runEnroll(store *stateStore, args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	server := fs.String("server", "", "WolUPS base URL")
	token := fs.String("token", "", "one-time enrollment token")
	releaseBase := fs.String("release-base", defaultReleaseBase, "HTTPS directory with agent releases")
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
	pending := store.dir + "/pending-key"
	if data, err := os.ReadFile(pending); err == nil && len(data) == ed25519.SeedSize {
		copy(seed, data)
	} else {
		if _, err := rand.Read(seed); err != nil {
			return err
		}
		if err := os.MkdirAll(store.dir, 0o700); err != nil {
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
		"info":      currentInfo(),
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
	st := &persistedState{
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
	if err := store.save(st); err != nil {
		return err
	}
	_ = os.Remove(pending)
	fmt.Printf("Paired with WolUPS as %q\n", result.DeviceName)
	return nil
}

func runServe(store *stateStore) error {
	st, err := store.load()
	if errors.Is(err, errNotPaired) {
		log.Print("agent is not paired. Run the install command from the WolUPS UI.")
		return nil
	}
	if err != nil {
		return err
	}
	if repairUnit() {
		// Non-zero exit makes systemd (Restart=on-failure) start the agent again under the new file.
		os.Exit(75)
	}
	binaryPath, err := os.Executable()
	if err != nil {
		return err
	}
	a, err := newAgent(store, st, systemActions(st, binaryPath))
	if err != nil {
		return err
	}
	log.Printf("wolups-agent %s starting", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	a.run(ctx)
	return nil
}

func runStatus(store *stateStore) error {
	st, err := store.load()
	if errors.Is(err, errNotPaired) {
		fmt.Println("Not paired")
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Printf("Version:  %s\nServer:   %s\nDevice:   %s\nAgent ID: %s\nPaired:   %s\n",
		version, st.ServerURL, st.DeviceName, st.AgentID, time.UnixMilli(st.EnrolledAt).Format(time.RFC3339))
	return nil
}

func runReset(store *stateStore, args []string) error {
	if len(args) == 0 || args[0] != "--confirm" {
		return errors.New("this removes the pairing; run again with --confirm")
	}
	if err := store.remove(); err != nil {
		return err
	}
	fmt.Println("Pairing removed. Stop the service or pair again from the WolUPS UI.")
	return nil
}
