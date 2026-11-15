package core

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ProtocolVersion is wire protocol v1. Keep in sync with src/server/agents/protocol.ts.
const ProtocolVersion = 1

const maxClockSkew = 10 * time.Minute

func helloMessage(agentID, nonce string, ts int64) string {
	return fmt.Sprintf("wolups-hello:v1\n%s\n%s\n%d", agentID, nonce, ts)
}

func commandMessage(payload string) string {
	return "wolups-command:v1\n" + payload
}

type serverMessage struct {
	Type     string `json:"type"`
	Nonce    string `json:"nonce,omitempty"`
	Protocol int    `json:"protocol,omitempty"`
	Payload  string `json:"payload,omitempty"`
	Sig      string `json:"sig,omitempty"`
	Device   string `json:"deviceName,omitempty"`
}

// Command is a verified command from the server.
type Command struct {
	V         int             `json:"v"`
	ID        string          `json:"id"`
	AgentID   string          `json:"agentId"`
	Type      string          `json:"type"`
	Args      json.RawMessage `json:"args"`
	IssuedAt  int64           `json:"issuedAt"`
	ExpiresAt int64           `json:"expiresAt"`
}

// AgentInfo is sent with hello and every status message.
type AgentInfo struct {
	Version    string          `json:"version"`
	Protocol   int             `json:"protocol"`
	OS         string          `json:"os"`
	Arch       string          `json:"arch"`
	Hostname   string          `json:"hostname"`
	Interfaces []InterfaceInfo `json:"interfaces"`
}

type InterfaceInfo struct {
	Name  string   `json:"name"`
	MAC   string   `json:"mac"`
	CIDRs []string `json:"cidrs"`
}

type helloMsg struct {
	Type    string    `json:"type"`
	AgentID string    `json:"agentId"`
	Nonce   string    `json:"nonce"`
	TS      int64     `json:"ts"`
	Sig     string    `json:"sig"`
	Info    AgentInfo `json:"info"`
}

type ackMsg struct {
	Type   string         `json:"type"`
	ID     string         `json:"id"`
	OK     bool           `json:"ok"`
	Error  string         `json:"error,omitempty"`
	Result map[string]any `json:"result,omitempty"`
}

type statusMsg struct {
	Type string    `json:"type"`
	Info AgentInfo `json:"info"`
}

// progressMsg carries output lines of a running command.
type progressMsg struct {
	Type  string   `json:"type"`
	ID    string   `json:"id"`
	Lines []string `json:"lines"`
}

func signHello(key ed25519.PrivateKey, agentID, nonce string, ts int64) string {
	sig := ed25519.Sign(key, []byte(helloMessage(agentID, nonce, ts)))
	return base64.RawURLEncoding.EncodeToString(sig)
}

// verifyCommand checks the server signature, the target agent, and the validity window.
func verifyCommand(serverKey ed25519.PublicKey, agentID, payload, sig string, now time.Time) (*Command, error) {
	rawSig, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || len(rawSig) != ed25519.SignatureSize {
		return nil, errors.New("malformed signature")
	}
	if !ed25519.Verify(serverKey, []byte(commandMessage(payload)), rawSig) {
		return nil, errors.New("signature rejected")
	}
	var cmd Command
	if err := json.Unmarshal([]byte(payload), &cmd); err != nil {
		return nil, errors.New("malformed command")
	}
	if cmd.V != ProtocolVersion {
		return nil, fmt.Errorf("unsupported command version %d", cmd.V)
	}
	if cmd.AgentID != agentID {
		return nil, errors.New("command is addressed to another agent")
	}
	if cmd.ID == "" {
		return nil, errors.New("command has no id")
	}
	nowMs := now.UnixMilli()
	if cmd.ExpiresAt < nowMs {
		return nil, errors.New("command expired")
	}
	if cmd.IssuedAt > nowMs+maxClockSkew.Milliseconds() {
		return nil, errors.New("command issued in the future, check the clock")
	}
	return &cmd, nil
}
