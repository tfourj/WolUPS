package core

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const statusInterval = 30 * time.Second

// Reply is a handler's answer. After runs once the acknowledgement was sent, for example a poweroff.
type Reply struct {
	Result map[string]any
	After  func()
}

// Handler runs one command type. Handlers are fixed operations: the server never supplies a command, path or URL.
type Handler struct {
	Run func(ctx context.Context, args json.RawMessage, out *Output) (Reply, error)
	// Async runs the command in its own goroutine, so long commands do not block the connection.
	Async bool
}

// Options configure an Agent.
type Options struct {
	Component Component
	Store     *StateStore
	State     *PersistedState
	// Handlers for the component's own commands. ping, update and unpair are built in.
	Handlers map[string]Handler
	// Update installs a newer release. Defaults to the GitHub release lookup.
	Update func() (UpdateOutcome, error)
	// Exit ends the process. Defaults to os.Exit.
	Exit func(code int)
	// Loops run while a session is connected, for example periodic reports. Send writes one message.
	Loops []func(ctx context.Context, send func(any) error)
}

// Agent keeps the connection to the server and runs signed commands.
type Agent struct {
	opts   Options
	key    ed25519.PrivateKey
	server ed25519.PublicKey
	now    func() time.Time

	writeMu sync.Mutex
	conn    *websocket.Conn
}

// NewAgent checks the stored keys and prepares an agent.
func NewAgent(opts Options) (*Agent, error) {
	key, err := opts.State.privateKey()
	if err != nil {
		return nil, err
	}
	server, err := opts.State.serverKey()
	if err != nil {
		return nil, err
	}
	return &Agent{opts: opts, key: key, server: server, now: time.Now}, nil
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

// Run keeps a connection open, reconnecting with jittered backoff.
func (a *Agent) Run(ctx context.Context) {
	backoff := time.Second
	errorsLog := newRepeatLog(time.Hour)
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			return
		}
		wait := backoff
		var closeErr websocket.CloseError
		if errors.As(err, &closeErr) && (closeErr.Code == 4404 || closeErr.Code == 4401) {
			errorsLog.Print(fmt.Sprintf("server rejected this agent (%s). Pair it again from the WolUPS UI.", closeErr.Reason))
			wait = 5 * time.Minute
		} else {
			errorsLog.Print(fmt.Sprintf("connection lost: %v", err))
		}
		if time.Since(started) > time.Minute {
			// The session was up for a while, so this is a new problem worth logging.
			backoff = time.Second
			errorsLog.Reset()
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

func (a *Agent) session(ctx context.Context) error {
	wsURL, err := websocketURL(a.opts.State.ServerURL)
	if err != nil {
		return err
	}
	loopback := false
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPClient: a.serverClient(&loopback),
		HTTPHeader: map[string][]string{"User-Agent": {a.opts.Component.Name + "/" + a.opts.Component.Version}},
	})
	cancel()
	if err != nil {
		return err
	}
	conn.SetReadLimit(256 * 1024)
	defer func() {
		a.writeMu.Lock()
		a.conn = nil
		a.writeMu.Unlock()
		conn.CloseNow()
	}()
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
		AgentID: a.opts.State.AgentID,
		Nonce:   challenge.Nonce,
		TS:      ts,
		Sig:     signHello(a.key, a.opts.State.AgentID, challenge.Nonce, ts),
		Info:    CurrentInfo(a.opts.Component.Version),
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
			via := ""
			if loopback {
				via = " through 127.0.0.1"
			}
			log.Printf("connected to %s%s as %q", a.opts.State.ServerURL, via, msg.Device)
			for _, loop := range a.opts.Loops {
				go loop(sessionCtx, func(v any) error { return a.write(sessionCtx, v) })
			}
		case "command":
			a.handleCommand(sessionCtx, msg.Payload, msg.Sig)
		}
	}
}

func (a *Agent) read(ctx context.Context, conn *websocket.Conn, target any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (a *Agent) write(ctx context.Context, value any) error {
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

func (a *Agent) statusLoop(ctx context.Context) {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.write(ctx, statusMsg{Type: "status", Info: CurrentInfo(a.opts.Component.Version)}); err != nil {
				return
			}
		}
	}
}

func (a *Agent) ack(ctx context.Context, id string, err error, result map[string]any) {
	msg := ackMsg{Type: "ack", ID: id, OK: err == nil, Result: result}
	if err != nil {
		msg.Error = err.Error()
	}
	if writeErr := a.write(ctx, msg); writeErr != nil {
		log.Printf("could not acknowledge %s: %v", id, writeErr)
	}
}

func (a *Agent) exit(code int) {
	if a.opts.Exit != nil {
		a.opts.Exit(code)
		return
	}
	exitProcess(code)
}

func (a *Agent) builtin(cmdType string) (Handler, bool) {
	switch cmdType {
	case "ping":
		return Handler{Run: func(context.Context, json.RawMessage, *Output) (Reply, error) { return Reply{}, nil }}, true
	case "update":
		return Handler{Run: func(context.Context, json.RawMessage, *Output) (Reply, error) {
			log.Print("update requested")
			update := a.opts.Update
			if update == nil {
				update = func() (UpdateOutcome, error) {
					return Update(a.opts.Component, a.opts.State.ReleaseBase, a.opts.Component.BinaryPath)
				}
			}
			outcome, err := update()
			if err != nil {
				return Reply{}, err
			}
			reply := Reply{Result: map[string]any{"updated": outcome.Updated, "latestVersion": outcome.LatestVersion}}
			if outcome.Updated {
				reply.After = func() {
					log.Printf("updated to %s, restarting", outcome.LatestVersion)
					time.Sleep(time.Second)
					// Non-zero exit makes systemd (Restart=on-failure) start the new binary.
					a.exit(75)
				}
			}
			return reply, nil
		}}, true
	case "unpair":
		return Handler{Run: func(context.Context, json.RawMessage, *Output) (Reply, error) {
			log.Print("unpaired by server, removing local pairing state")
			return Reply{After: func() {
				time.Sleep(500 * time.Millisecond)
				if err := a.opts.Store.Remove(); err != nil {
					log.Printf("could not remove state: %v", err)
				}
				// Exit cleanly so systemd leaves the service stopped until it is paired again.
				a.exit(0)
			}}, nil
		}}, true
	}
	return Handler{}, false
}

func (a *Agent) handleCommand(ctx context.Context, payload, sig string) {
	cmd, err := verifyCommand(a.server, a.opts.State.AgentID, payload, sig, a.now())
	if err != nil {
		log.Printf("rejected command: %v", err)
		// Only acknowledge when the ID can be read from a correctly signed payload.
		return
	}
	fresh, err := a.opts.Store.markProcessed(cmd.ID, a.now())
	if err != nil {
		a.ack(ctx, cmd.ID, fmt.Errorf("could not record command: %w", err), nil)
		return
	}
	if !fresh {
		// Already handled: acknowledge again without repeating the action.
		a.ack(ctx, cmd.ID, nil, map[string]any{"duplicate": true})
		return
	}

	handler, ok := a.builtin(cmd.Type)
	if !ok {
		handler, ok = a.opts.Handlers[cmd.Type]
	}
	if !ok {
		a.ack(ctx, cmd.ID, fmt.Errorf("unsupported command %q", cmd.Type), nil)
		return
	}
	run := func() {
		out := newOutput(cmd.ID, func(v any) error { return a.write(ctx, v) })
		reply, err := handler.Run(ctx, cmd.Args, out)
		out.Flush()
		a.ack(ctx, cmd.ID, err, reply.Result)
		if err == nil && reply.After != nil {
			reply.After()
		}
	}
	if handler.Async {
		go run()
	} else {
		run()
	}
}
