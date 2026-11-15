package core

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// DefaultReleaseBase is the releases page agents update from. Each component picks its own tag prefix there.
	DefaultReleaseBase = "https://github.com/tfourj/WolUPS/releases"
	maxProcessed       = 500
)

// PersistedState is everything the agent needs to reconnect. It is stored root-only (0600).
type PersistedState struct {
	ServerURL       string           `json:"server_url"`
	AgentID         string           `json:"agent_id"`
	PrivateKey      string           `json:"private_key"`       // base64url Ed25519 seed
	ServerPublicKey string           `json:"server_public_key"` // base64url raw Ed25519 key
	ReleaseBase     string           `json:"release_base"`
	DeviceName      string           `json:"device_name,omitempty"`
	EnrolledAt      int64            `json:"enrolled_at"`
	Processed       map[string]int64 `json:"processed,omitempty"`
}

func (s *PersistedState) privateKey() (ed25519.PrivateKey, error) {
	seed, err := base64.RawURLEncoding.DecodeString(s.PrivateKey)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("stored private key is invalid")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func (s *PersistedState) serverKey() (ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s.ServerPublicKey)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("stored server public key is invalid")
	}
	return ed25519.PublicKey(raw), nil
}

// StateStore keeps the pairing state in Dir.
type StateStore struct {
	Dir string
	mu  sync.Mutex
}

// ErrNotPaired means there is no state file yet.
var ErrNotPaired = errors.New("agent is not paired")

func (s *StateStore) path() string { return filepath.Join(s.Dir, "state.json") }

func (s *StateStore) Load() (*PersistedState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *StateStore) loadLocked() (*PersistedState, error) {
	data, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotPaired
	}
	if err != nil {
		return nil, err
	}
	var state PersistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.Processed == nil {
		state.Processed = map[string]int64{}
	}
	return &state, nil
}

func (s *StateStore) Save(state *PersistedState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(state)
}

func (s *StateStore) saveLocked(state *PersistedState) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(s.Dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

func (s *StateStore) Remove() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := os.Remove(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// markProcessed records a command ID. It returns false when the ID was already seen,
// so a resent shutdown never schedules a second poweroff.
func (s *StateStore) markProcessed(id string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadLocked()
	if err != nil {
		return false, err
	}
	if _, seen := state.Processed[id]; seen {
		return false, nil
	}
	state.Processed[id] = now.UnixMilli()
	pruneProcessed(state.Processed, maxProcessed)
	return true, s.saveLocked(state)
}

func pruneProcessed(values map[string]int64, limit int) {
	for len(values) > limit {
		oldestID := ""
		var oldest int64
		for id, at := range values {
			if oldestID == "" || at < oldest {
				oldestID, oldest = id, at
			}
		}
		delete(values, oldestID)
	}
}
