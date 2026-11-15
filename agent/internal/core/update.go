package core

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
	"strconv"
	"strings"
	"time"
)

const (
	maxMetadataBytes = 1 << 20
	maxAgentBytes    = 128 << 20
	githubAPI        = "https://api.github.com"
	githubWeb        = "https://github.com"
)

var stableVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// githubReleases matches a repository's releases page. Agents paired before separate agent releases saved
// .../releases/latest/download, which is treated the same way.
var githubReleases = regexp.MustCompile(
	`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases(/latest/download)?$`,
)

type releaseManifest struct {
	Version         string `json:"version"`
	ProtocolVersion int    `json:"protocol_version"`
}

// UpdateOutcome says whether a newer release was installed.
type UpdateOutcome struct {
	Updated       bool
	LatestVersion string
}

// updater installs a newer agent from the release source saved at enrollment: a GitHub releases page, where it
// picks the newest release with the component's tag prefix, or a fixed HTTPS directory. The server can only
// trigger it; it never supplies a URL, path or command.
type updater struct {
	component   Component
	releaseBase string
	binaryPath  string
	arch        string
	client      *http.Client
	verify      func(path, expected string) error
	// apiURL and webURL replace the GitHub hosts in tests.
	apiURL string
	webURL string
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

type githubRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// newestTag returns the highest stable <prefix>X.Y.Z tag among the repository's releases.
func newestTag(releases []githubRelease, prefix string) (string, error) {
	best, bestTag := [3]int{}, ""
	for _, r := range releases {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.TagName, prefix) {
			continue
		}
		v, err := parseStable(strings.TrimPrefix(r.TagName, prefix))
		if err != nil {
			continue
		}
		if bestTag == "" || greaterVersion(v, best) {
			best, bestTag = v, r.TagName
		}
	}
	if bestTag == "" {
		return "", fmt.Errorf("no %sX.Y.Z release found", prefix)
	}
	return bestTag, nil
}

// releaseDir returns the HTTPS directory that holds the release files to install.
func (u *updater) releaseDir() (string, error) {
	match := githubReleases.FindStringSubmatch(u.releaseBase)
	if match == nil {
		return u.releaseBase, nil
	}
	owner, repo := match[1], match[2]
	apiURL, webURL := u.apiURL, u.webURL
	if apiURL == "" {
		apiURL = githubAPI
	}
	if webURL == "" {
		webURL = githubWeb
	}
	listURL := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=100", apiURL, owner, repo)
	req, err := http.NewRequest(http.MethodGet, listURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", u.component.Name)
	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("list releases: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		return "", errors.New("list releases: GitHub API rate limit reached, try again later")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("list releases: HTTP %d", resp.StatusCode)
	}
	var releases []githubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxMetadataBytes*8)).Decode(&releases); err != nil {
		return "", errors.New("list releases: invalid response")
	}
	tag, err := newestTag(releases, u.component.TagPrefix)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s/%s/%s/releases/download/%s", webURL, owner, repo, tag), nil
}

func (u *updater) fetch(dir, name string, limit int64) ([]byte, error) {
	resp, err := u.client.Get(dir + "/" + name)
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

func (u *updater) fetchVerified(dir, name string, limit int64) ([]byte, error) {
	data, err := u.fetch(dir, name, limit)
	if err != nil {
		return nil, err
	}
	sums, err := u.fetch(dir, name+".sha256", maxMetadataBytes)
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
	return greaterVersion(c, cur), nil
}

func greaterVersion(a, b [3]int) bool {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func (u *updater) run(current string) (UpdateOutcome, error) {
	source, err := u.releaseDir()
	if err != nil {
		return UpdateOutcome{}, err
	}
	data, err := u.fetchVerified(source, u.component.Manifest, maxMetadataBytes)
	if err != nil {
		return UpdateOutcome{}, err
	}
	var manifest releaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return UpdateOutcome{}, errors.New("release manifest is invalid")
	}
	if _, err := parseStable(manifest.Version); err != nil {
		return UpdateOutcome{}, err
	}
	if manifest.ProtocolVersion != ProtocolVersion {
		return UpdateOutcome{}, errors.New("release uses an incompatible protocol version")
	}
	newer, err := isNewer(current, manifest.Version)
	if err != nil {
		return UpdateOutcome{}, err
	}
	if !newer {
		return UpdateOutcome{Updated: false, LatestVersion: manifest.Version}, nil
	}

	asset, err := u.component.Asset(u.arch)
	if err != nil {
		return UpdateOutcome{}, err
	}
	binary, err := u.fetchVerified(source, asset, maxAgentBytes)
	if err != nil {
		return UpdateOutcome{}, err
	}

	dir := filepath.Dir(u.binaryPath)
	tmp, err := os.CreateTemp(dir, "."+u.component.Name+"-update-*")
	if err != nil {
		return UpdateOutcome{}, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return UpdateOutcome{}, err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return UpdateOutcome{}, err
	}
	if err := tmp.Close(); err != nil {
		return UpdateOutcome{}, err
	}
	verify := u.verify
	if verify == nil {
		verify = func(path, version string) error { return verifyBinaryVersion(path, u.component.VersionLine(version)) }
	}
	if err := verify(tmpPath, manifest.Version); err != nil {
		return UpdateOutcome{}, fmt.Errorf("downloaded agent failed verification: %w", err)
	}
	if err := os.Rename(tmpPath, u.binaryPath); err != nil {
		return UpdateOutcome{}, fmt.Errorf("replace agent binary: %w", err)
	}
	return UpdateOutcome{Updated: true, LatestVersion: manifest.Version}, nil
}

// verifyBinaryVersion runs the new binary with the fixed `version` argument and checks its output.
func verifyBinaryVersion(path, want string) error {
	out, err := exec.Command(path, "version").Output()
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) != want {
		return errors.New("unexpected version output")
	}
	return nil
}

// Update installs the newest release of the component over binaryPath when it is newer than the running version.
func Update(c Component, releaseBase, binaryPath string) (UpdateOutcome, error) {
	base, err := validateReleaseBase(releaseBase)
	if err != nil {
		return UpdateOutcome{}, err
	}
	u := &updater{component: c, releaseBase: base, binaryPath: binaryPath, client: httpsOnlyClient(2 * time.Minute)}
	return u.run(c.Version)
}
