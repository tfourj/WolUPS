package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	manifestName     = "agent-release.json"
	maxMetadataBytes = 1 << 20
	maxAgentBytes    = 128 << 20
)

var stableVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type releaseManifest struct {
	Version         string `json:"version"`
	ProtocolVersion int    `json:"protocol_version"`
}

type updateOutcome struct {
	Updated       bool
	LatestVersion string
}

// updater installs a newer agent from the release directory saved at enrollment.
// The server can only trigger it; it never supplies a URL, path or command.
type updater struct {
	releaseBase string
	binaryPath  string
	arch        string
	client      *http.Client
	verify      func(path, expected string) error
}

func validateReleaseBase(value string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(value), "/")
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" {
		return "", errors.New("release base must be an HTTPS URL without credentials or query")
	}
	return trimmed, nil
}

func httpsOnlyClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" {
				return errors.New("redirect to non-HTTPS URL refused")
			}
			return nil
		},
	}
}

func (u *updater) fetch(name string, limit int64) ([]byte, error) {
	resp, err := u.client.Get(u.releaseBase + "/" + name)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", name, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("download %s: file too large", name)
	}
	return data, nil
}

func checksumFor(file []byte, name string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(file))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name && len(fields[0]) == 64 {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("no checksum for %s", name)
}

func verifyChecksum(data []byte, expected string) error {
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expected {
		return errors.New("checksum mismatch")
	}
	return nil
}

func (u *updater) fetchVerified(name string, limit int64) ([]byte, error) {
	data, err := u.fetch(name, limit)
	if err != nil {
		return nil, err
	}
	sums, err := u.fetch(name+".sha256", maxMetadataBytes)
	if err != nil {
		return nil, err
	}
	expected, err := checksumFor(sums, name)
	if err != nil {
		return nil, err
	}
	if err := verifyChecksum(data, expected); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return data, nil
}

func parseStable(value string) ([3]int, error) {
	var out [3]int
	if !stableVersion.MatchString(value) {
		return out, fmt.Errorf("%q is not a stable x.y.z version", value)
	}
	for i, part := range strings.Split(value, ".") {
		out[i], _ = strconv.Atoi(part)
	}
	return out, nil
}

func isNewer(current, candidate string) (bool, error) {
	c, err := parseStable(candidate)
	if err != nil {
		return false, err
	}
	cur, err := parseStable(current)
	if err != nil {
		return true, nil // dev builds always accept a stable release
	}
	for i := 0; i < 3; i++ {
		if c[i] != cur[i] {
			return c[i] > cur[i], nil
		}
	}
	return false, nil
}

func (u *updater) run(current string) (updateOutcome, error) {
	data, err := u.fetchVerified(manifestName, maxMetadataBytes)
	if err != nil {
		return updateOutcome{}, err
	}
	var manifest releaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return updateOutcome{}, errors.New("release manifest is invalid")
	}
	if _, err := parseStable(manifest.Version); err != nil {
		return updateOutcome{}, err
	}
	if manifest.ProtocolVersion != protocolVersion {
		return updateOutcome{}, errors.New("release uses an incompatible protocol version")
	}
	newer, err := isNewer(current, manifest.Version)
	if err != nil {
		return updateOutcome{}, err
	}
	if !newer {
		return updateOutcome{Updated: false, LatestVersion: manifest.Version}, nil
	}

	arch := u.arch
	if arch == "" {
		arch = runtime.GOARCH
	}
	if arch != "amd64" && arch != "arm64" {
		return updateOutcome{}, fmt.Errorf("unsupported architecture %s", arch)
	}
	asset := "wolups-agent-linux-" + arch
	binary, err := u.fetchVerified(asset, maxAgentBytes)
	if err != nil {
		return updateOutcome{}, err
	}

	dir := filepath.Dir(u.binaryPath)
	tmp, err := os.CreateTemp(dir, ".wolups-agent-update-*")
	if err != nil {
		return updateOutcome{}, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return updateOutcome{}, err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return updateOutcome{}, err
	}
	if err := tmp.Close(); err != nil {
		return updateOutcome{}, err
	}
	verify := u.verify
	if verify == nil {
		verify = verifyBinaryVersion
	}
	if err := verify(tmpPath, manifest.Version); err != nil {
		return updateOutcome{}, fmt.Errorf("downloaded agent failed verification: %w", err)
	}
	if err := os.Rename(tmpPath, u.binaryPath); err != nil {
		return updateOutcome{}, fmt.Errorf("replace agent binary: %w", err)
	}
	return updateOutcome{Updated: true, LatestVersion: manifest.Version}, nil
}

// verifyBinaryVersion runs the new binary with the fixed `version` argument and checks its output.
func verifyBinaryVersion(path, expected string) error {
	out, err := exec.Command(path, "version").Output()
	if err != nil {
		return err
	}
	want := fmt.Sprintf("wolups-agent %s protocol v%d", expected, protocolVersion)
	if strings.TrimSpace(string(out)) != want {
		return errors.New("unexpected version output")
	}
	return nil
}
