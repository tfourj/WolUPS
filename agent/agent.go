package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const statusInterval = 30 * time.Second

// actions are the only side effects the server can trigger. They are fixed operations;
// the server never supplies a command, path or URL.
type actions struct {
	poweroff func() error
	wake     func(mac, broadcast string, port int) (int, error)
	update   func() (updateOutcome, error)
	exit     func(code int)
}

func systemActions(st *persistedState, binaryPath string) actions {
	dryRun := os.Getenv("WOLUPS_AGENT_DRY_RUN") == "1"
	return actions{
		poweroff: func() error {
			if dryRun {
				log.Print("dry run: would power off now")
				return nil
			}
			for _, path := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
				if _, err := os.Stat(path); err == nil {
					return exec.Command(path, "poweroff").Run()
				}
			}
			return errors.New("systemctl not found")
		},
		wake: sendWake,
		update: func() (updateOutcome, error) {
			base, err := validateReleaseBase(st.ReleaseBase)
			if err != nil {
				return updateOutcome{}, err
			}
			u := &updater{releaseBase: base, binaryPath: binaryPath, client: httpsOnlyClient(2 * time.Minute)}
			return u.run(version)
		},
		exit: os.Exit,
	}
}

type agent struct {
	store   *stateStore
	state   *persistedState
	key     ed25519.PrivateKey
	server  ed25519.PublicKey
	actions actions
	now     func() time.Time

	writeMu sync.Mutex
	conn    *websocket.Conn
}

func newAgent(store *stateStore, st *persistedState, acts actions) (*agent, error) {
	key, err := st.privateKey()
	if err != nil {
		return nil, err
	}
	server, err := st.serverKey()
	if err != nil {
		return nil, err
	}
	return &agent{store: store, state: st, key: key, server: server, actions: acts, now: time.Now}, nil
}

func websocketURL(serverURL string) (string, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported server URL scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/agents/ws"
	return u.String(), nil
}

// run keeps a connection open, reconnecting with jittered backoff.
func (a *agent) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			return
		}
		wait := backoff
		var closeErr websocket.CloseError
		if errors.As(err, &closeErr) && (closeErr.Code == 4404 || closeErr.Code == 4401) {
			log.Printf("server rejected this agent (%s). Pair it again from the WolUPS UI.", closeErr.Reason)
			wait = 5 * time.Minute
		} else {
			log.Printf("connection lost: %v", err)
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		} else if backoff < time.Minute {
			backoff *= 2
		}
		wait += time.Duration(rand.Int64N(int64(time.Second)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (a *agent) session(ctx context.Context) error {
	wsURL, err := websocketURL(a.state.ServerURL)
	if err != nil {
		return err
	}
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"User-Agent": {"wolups-agent/" + version}},
	})
	cancel()
	if err != nil {
		return err
	}
	conn.SetReadLimit(256 * 1024)
	defer conn.CloseNow()
	a.writeMu.Lock()
	a.conn = conn
	a.writeMu.Unlock()

	var challenge serverMessage
	if err := a.read(ctx, conn, &challenge); err != nil {
		return err
	}
	if challenge.Type != "challenge" || challenge.Nonce == "" {
		return errors.New("server did not send a challenge")
	}
	ts := a.now().UnixMilli()
	hello := helloMsg{
		Type:    "hello",
		AgentID: a.state.AgentID,
		Nonce:   challenge.Nonce,
		TS:      ts,
		Sig:     signHello(a.key, a.state.AgentID, challenge.Nonce, ts),
		Info:    currentInfo(),
	}
	if err := a.write(ctx, hello); err != nil {
		return err
	}

	sessionCtx, stop := context.WithCancel(ctx)
	defer stop()
	go a.statusLoop(sessionCtx)

	for {
		var msg serverMessage
		if err := a.read(sessionCtx, conn, &msg); err != nil {
			return err
		}
		switch msg.Type {
		case "welcome":
			log.Printf("connected to %s as %q", a.state.ServerURL, msg.Device)
		case "command":
			a.handleCommand(sessionCtx, msg.Payload, msg.Sig)
		}
	}
}

func (a *agent) read(ctx context.Context, conn *websocket.Conn, target any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (a *agent) write(ctx context.Context, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	if a.conn == nil {
		return errors.New("not connected")
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return a.conn.Write(writeCtx, websocket.MessageText, data)
}

func (a *agent) statusLoop(ctx context.Context) {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.write(ctx, statusMsg{Type: "status", Info: currentInfo()}); err != nil {
				return
			}
		}
	}
}

func (a *agent) ack(ctx context.Context, id string, err error, result map[string]any) {
	msg := ackMsg{Type: "ack", ID: id, OK: err == nil, Result: result}
	if err != nil {
		msg.Error = err.Error()
	}
	if writeErr := a.write(ctx, msg); writeErr != nil {
		log.Printf("could not acknowledge %s: %v", id, writeErr)
	}
}

type shutdownArgs struct {
	Reason    string `json:"reason"`
	UPS       string `json:"ups"`
	Battery   *int   `json:"battery"`
	Threshold *int   `json:"threshold"`
}

type wakeArgs struct {
	MAC       string `json:"mac"`
	Broadcast string `json:"broadcast"`
	Port      int    `json:"port"`
}

func (a *agent) handleCommand(ctx context.Context, payload, sig string) {
	cmd, err := verifyCommand(a.server, a.state.AgentID, payload, sig, a.now())
	if err != nil {
		log.Printf("rejected command: %v", err)
		// Only acknowledge when the ID can be read from a correctly signed payload.
		return
	}
	fresh, err := a.store.markProcessed(cmd.ID, a.now())
	if err != nil {
		a.ack(ctx, cmd.ID, fmt.Errorf("could not record command: %w", err), nil)
		return
	}
	if !fresh {
		// Already handled: acknowledge again without repeating the action.
		a.ack(ctx, cmd.ID, nil, map[string]any{"duplicate": true})
		return
	}

	switch cmd.Type {
	case "ping":
		a.ack(ctx, cmd.ID, nil, nil)
	case "shutdown":
		var args shutdownArgs
		_ = json.Unmarshal(cmd.Args, &args)
		log.Printf("shutdown requested (reason=%s ups=%s)", args.Reason, args.UPS)
		a.ack(ctx, cmd.ID, nil, nil)
		go func() {
			time.Sleep(2 * time.Second)
			if err := a.actions.poweroff(); err != nil {
				log.Printf("poweroff failed: %v", err)
			}
		}()
	case "wol":
		var args wakeArgs
		if err := json.Unmarshal(cmd.Args, &args); err != nil {
			a.ack(ctx, cmd.ID, errors.New("invalid wake arguments"), nil)
			return
		}
		sent, err := a.actions.wake(args.MAC, args.Broadcast, args.Port)
		a.ack(ctx, cmd.ID, err, map[string]any{"targets": sent})
	case "update":
		log.Print("update requested")
		outcome, err := a.actions.update()
		if err != nil {
			a.ack(ctx, cmd.ID, err, nil)
			return
		}
		a.ack(ctx, cmd.ID, nil, map[string]any{"updated": outcome.Updated, "latestVersion": outcome.LatestVersion})
		if outcome.Updated {
			log.Printf("updated to %s, restarting", outcome.LatestVersion)
			time.Sleep(time.Second)
			// Non-zero exit makes systemd (Restart=on-failure) start the new binary.
			a.actions.exit(75)
		}
	case "unpair":
		log.Print("unpaired by server, removing local pairing state")
		a.ack(ctx, cmd.ID, nil, nil)
		time.Sleep(500 * time.Millisecond)
		if err := a.store.remove(); err != nil {
			log.Printf("could not remove state: %v", err)
		}
		// Exit cleanly so systemd leaves the service stopped until it is paired again.
		a.actions.exit(0)
	default:
		a.ack(ctx, cmd.ID, fmt.Errorf("unsupported command %q", cmd.Type), nil)
	}
}
