// Package nut reads and writes the NUT config and runs NUT tools for wolups-nut-agent.
package nut

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	blockBegin = "# BEGIN wolups"
	blockEnd   = "# END wolups"
	// NUTPort is the port upsd listens on.
	NUTPort = 3493
)

var (
	upsNamePattern   = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
	confValuePattern = regexp.MustCompile(`^[A-Za-z0-9._:/@-]{1,128}$`)
	secretPattern    = regexp.MustCompile(`^[\x20-\x7e]{8,64}$`)
	descPattern      = regexp.MustCompile(`^[^"\\\n]{0,100}$`)
)

// allowedExtra are the ups.conf keys a managed UPS may carry besides driver, port and desc.
var allowedExtra = map[string]bool{
	"vendorid": true, "productid": true, "serial": true, "bus": true, "community": true, "snmp_version": true,
	"pollinterval": true, "secLevel": true, "secName": true, "authProtocol": true, "authPassword": true,
	"privProtocol": true, "privPassword": true,
}

// SecretKeys hold passwords. They are masked in output and never returned to the server.
var SecretKeys = map[string]bool{"community": true, "authPassword": true, "privPassword": true}

// Section is one UPS in ups.conf.
type Section struct {
	Name   string            `json:"name"`
	Driver string            `json:"driver"`
	Port   string            `json:"port"`
	Desc   string            `json:"desc,omitempty"`
	Extra  map[string]string `json:"extra,omitempty"`
}

func validSecret(value string) bool {
	return secretPattern.MatchString(value) && !strings.ContainsAny(value, `"\`)
}

// Validate checks a section from the server before it is written.
func (s Section) Validate() error {
	if !upsNamePattern.MatchString(s.Name) {
		return fmt.Errorf("invalid UPS name %q", s.Name)
	}
	if !confValuePattern.MatchString(s.Driver) || !confValuePattern.MatchString(s.Port) {
		return fmt.Errorf("%s: invalid driver or port", s.Name)
	}
	if !descPattern.MatchString(s.Desc) {
		return fmt.Errorf("%s: invalid description", s.Name)
	}
	for key, value := range s.Extra {
		if !allowedExtra[key] {
			return fmt.Errorf("%s: %s is not an allowed ups.conf key", s.Name, key)
		}
		ok := confValuePattern.MatchString(value)
		switch key {
		case "authPassword", "privPassword":
			ok = validSecret(value)
		case "community":
			ok = ok || validSecret(value)
		}
		if !ok {
			return fmt.Errorf("%s: invalid value for %s", s.Name, key)
		}
	}
	return nil
}

func quote(value string) string {
	return `"` + value + `"`
}

// render writes the section in ups.conf syntax. Values are validated, so quoting needs no escapes.
func (s Section) render() string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\n", s.Name)
	fmt.Fprintf(&b, "\tdriver = %s\n", quote(s.Driver))
	fmt.Fprintf(&b, "\tport = %s\n", quote(s.Port))
	if s.Desc != "" {
		fmt.Fprintf(&b, "\tdesc = %s\n", quote(s.Desc))
	}
	keys := make([]string, 0, len(s.Extra))
	for key := range s.Extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Fprintf(&b, "\t%s = %s\n", key, quote(s.Extra[key]))
	}
	return b.String()
}

// ParseUpsConf reads the UPS sections of ups.conf, including ones WolUPS manages. Global settings before the first
// section are skipped.
func ParseUpsConf(text string) []Section {
	var out []Section
	var current *Section
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			out = append(out, Section{Name: strings.TrimSpace(line[1 : len(line)-1]), Extra: map[string]string{}})
			current = &out[len(out)-1]
			continue
		}
		if current == nil {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"`)
		switch key {
		case "driver":
			current.Driver = value
		case "port":
			current.Port = value
		case "desc":
			current.Desc = value
		default:
			current.Extra[key] = value
		}
	}
	return out
}

// splitBlock returns the text outside the WolUPS block and whether a block was there.
func splitBlock(text string) (before, after string, found bool) {
	start := strings.Index(text, blockBegin)
	if start < 0 {
		return text, "", false
	}
	end := strings.Index(text[start:], blockEnd)
	if end < 0 {
		return text[:start], "", true
	}
	rest := text[start+end+len(blockEnd):]
	return text[:start], strings.TrimPrefix(rest, "\n"), true
}

// withBlock replaces the WolUPS block in text with body, or appends one. An empty body removes the block.
func withBlock(text, body string) string {
	before, after, _ := splitBlock(text)
	outside := strings.TrimRight(before, "\n")
	if strings.TrimSpace(after) != "" {
		if outside != "" {
			outside += "\n"
		}
		outside += strings.TrimRight(after, "\n")
	}
	if strings.TrimSpace(body) == "" {
		if outside == "" {
			return ""
		}
		return outside + "\n"
	}
	block := blockBegin + "\n# Written by wolups-nut-agent. Changes inside this block are replaced.\n" +
		strings.TrimRight(body, "\n") + "\n" + blockEnd + "\n"
	if outside == "" {
		return block
	}
	return outside + "\n\n" + block
}

// outsideBlock is the text of a file without the WolUPS block.
func outsideBlock(text string) string {
	before, after, _ := splitBlock(text)
	return before + after
}

// blockText is the content of the WolUPS block.
func blockText(text string) string {
	start := strings.Index(text, blockBegin)
	if start < 0 {
		return ""
	}
	inner := text[start+len(blockBegin):]
	if end := strings.Index(inner, blockEnd); end >= 0 {
		inner = inner[:end]
	}
	return inner
}

// ManagedSections are the UPS sections inside the WolUPS block, as written, passwords included.
func ManagedSections(text string) []Section {
	return ParseUpsConf(blockText(text))
}

// rawSection is one ups.conf section as written: its header and every line up to the next section, so migrated
// and kept sections keep flags, comments and keys WolUPS does not know.
type rawSection struct {
	Name string
	Text string
}

// splitRaw splits text into what comes before the first section and the sections themselves. Joining the parts
// gives back the original text.
func splitRaw(text string) (string, []rawSection) {
	lines := strings.SplitAfter(text, "\n")
	var preamble strings.Builder
	var sections []rawSection
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			sections = append(sections, rawSection{Name: strings.TrimSpace(trimmed[1 : len(trimmed)-1])})
		}
		if len(sections) == 0 {
			preamble.WriteString(line)
		} else {
			sections[len(sections)-1].Text += line
		}
	}
	return preamble.String(), sections
}

// SectionEdit changes a few keys of a managed section in place. Every other line stays as written, so passwords,
// flags and keys WolUPS does not know survive an edit. An empty value removes desc or serial.
type SectionEdit struct {
	Name string            `json:"name"`
	Set  map[string]string `json:"set"`
}

// editableKeys are the keys an edit may change, with whether they may be cleared.
var editableKeys = map[string]bool{"desc": true, "port": false, "serial": true}

func (e SectionEdit) validate() error {
	if !upsNamePattern.MatchString(e.Name) {
		return fmt.Errorf("invalid UPS name %q", e.Name)
	}
	for key, value := range e.Set {
		clearable, ok := editableKeys[key]
		switch {
		case !ok:
			return fmt.Errorf("%s: %s cannot be edited", e.Name, key)
		case value == "" && !clearable:
			return fmt.Errorf("%s: %s cannot be empty", e.Name, key)
		case key == "desc" && !descPattern.MatchString(value):
			return fmt.Errorf("%s: invalid description", e.Name)
		case key != "desc" && value != "" && !confValuePattern.MatchString(value):
			return fmt.Errorf("%s: invalid value for %s", e.Name, key)
		}
	}
	return nil
}

// patchSection sets keys in a section's text, replacing their lines or adding them after the header.
func patchSection(text string, set map[string]string) string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		line := regexp.MustCompile(`(?m)^[ \t]*` + regexp.QuoteMeta(key) + `[ \t]*=.*\n?`)
		value := set[key]
		if value == "" {
			text = line.ReplaceAllString(text, "")
			continue
		}
		next := fmt.Sprintf("\t%s = %s\n", key, quote(value))
		if line.MatchString(text) {
			text = line.ReplaceAllLiteralString(text, next)
			continue
		}
		header, rest, _ := strings.Cut(text, "\n")
		text = header + "\n" + next + rest
	}
	return text
}

// UpsConfChange is what an apply does to ups.conf: Upsert adds or replaces managed sections, Remove drops them,
// Migrate moves sections from outside the block into it as written and Edit changes keys of managed sections.
type UpsConfChange struct {
	Upsert  []Section
	Remove  []string
	Migrate []string
	Edit    []SectionEdit
}

// RenderUpsConf applies a change to the WolUPS block in ups.conf. Managed sections it does not touch stay as they
// are, passwords included, and everything outside the block is kept. A new section must not clash with one outside
// the block.
func RenderUpsConf(current string, change UpsConfChange) (string, error) {
	upsert, remove, migrate := change.Upsert, change.Remove, change.Migrate
	outside := outsideBlock(current)
	preamble, outsideSections := splitRaw(outside)
	outsideNames := map[string]bool{}
	for _, s := range outsideSections {
		outsideNames[s.Name] = true
	}
	migrating := map[string]bool{}
	for _, name := range migrate {
		if !outsideNames[name] {
			return "", fmt.Errorf("%s is not in ups.conf outside the WolUPS block", name)
		}
		migrating[name] = true
	}
	removed := map[string]bool{}
	for _, name := range remove {
		removed[name] = true
	}
	replaced := map[string]Section{}
	for _, s := range upsert {
		if err := s.Validate(); err != nil {
			return "", err
		}
		if outsideNames[s.Name] && !migrating[s.Name] {
			return "", fmt.Errorf("%s already exists in ups.conf outside the WolUPS block; import it instead", s.Name)
		}
		if _, dup := replaced[s.Name]; dup {
			return "", fmt.Errorf("%s is listed twice", s.Name)
		}
		replaced[s.Name] = s
	}

	var managed []rawSection
	inBlock := map[string]bool{}
	_, blockSections := splitRaw(blockText(current))
	for _, s := range blockSections {
		inBlock[s.Name] = true
		if migrating[s.Name] {
			return "", fmt.Errorf("%s exists both inside and outside the WolUPS block", s.Name)
		}
		if removed[s.Name] {
			continue
		}
		if next, ok := replaced[s.Name]; ok {
			managed = append(managed, rawSection{s.Name, next.render()})
			delete(replaced, s.Name)
			continue
		}
		managed = append(managed, s)
	}
	var kept []string
	for _, s := range outsideSections {
		if !migrating[s.Name] {
			kept = append(kept, s.Text)
			continue
		}
		if next, ok := replaced[s.Name]; ok {
			managed = append(managed, rawSection{s.Name, next.render()})
			delete(replaced, s.Name)
		} else {
			managed = append(managed, s)
		}
	}
	for _, s := range upsert {
		if _, pending := replaced[s.Name]; pending && !removed[s.Name] {
			managed = append(managed, rawSection{s.Name, s.render()})
		}
	}
	for _, edit := range change.Edit {
		if err := edit.validate(); err != nil {
			return "", err
		}
		found := false
		for i := range managed {
			if managed[i].Name == edit.Name {
				managed[i].Text = patchSection(managed[i].Text, edit.Set)
				found = true
			}
		}
		if !found {
			return "", fmt.Errorf("%s is not managed by WolUPS; migrate it to edit it", edit.Name)
		}
	}

	var body strings.Builder
	for i, section := range managed {
		if i > 0 {
			body.WriteString("\n")
		}
		body.WriteString(strings.TrimRight(section.Text, "\n") + "\n")
	}
	if len(migrate) == 0 {
		// Nothing moved, so everything outside the block stays byte for byte.
		return withBlock(current, body.String()), nil
	}
	return withBlock(preamble+strings.Join(kept, ""), body.String()), nil
}

var listenLine = regexp.MustCompile(`(?m)^\s*LISTEN\s+(\S+)(?:\s+(\d+))?\s*$`)

// existingListen lists the addresses upsd already listens on for port 3493 outside the WolUPS block.
func existingListen(text string) []string {
	var out []string
	for _, match := range listenLine.FindAllStringSubmatch(outsideBlock(text), -1) {
		if match[2] == "" || match[2] == strconv.Itoa(NUTPort) {
			out = append(out, match[1])
		}
	}
	return out
}

func coveredBy(addr string, listening []string) bool {
	for _, l := range listening {
		if l == addr || l == "0.0.0.0" || l == "::" || l == "*" {
			return true
		}
	}
	return false
}

// RenderUpsdConf makes upsd listen on localhost and the chosen address. Addresses upsd already listens on outside
// the WolUPS block, directly or through a wildcard, are not added again: upsd cannot bind one address twice.
func RenderUpsdConf(current, listen string) (string, error) {
	if !regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`).MatchString(listen) {
		return "", errors.New("listen address must be an IPv4 address")
	}
	existing := existingListen(current)
	var body strings.Builder
	for _, addr := range []string{"127.0.0.1", listen} {
		if coveredBy(addr, existing) || strings.Contains(body.String(), "LISTEN "+addr+" ") {
			continue
		}
		fmt.Fprintf(&body, "LISTEN %s %d\n", addr, NUTPort)
	}
	return withBlock(current, body.String()), nil
}

// Users are the NUT accounts WolUPS keeps in upsd.users.
type Users struct {
	MonitorPassword string `json:"monitorPassword"`
	AdminPassword   string `json:"adminPassword"`
}

const (
	// MonitorUser is the read-only account the WolUPS server logs in with.
	MonitorUser = "wolups"
	// AdminUser runs instant commands and sets variables, and is upsmon's account on this host.
	AdminUser = "wolups-admin"
)

// RenderUsers writes both WolUPS accounts. NUT 2.7 calls the upsmon roles master and slave.
func RenderUsers(current string, users Users, legacyRoles bool) string {
	primary, secondary := "primary", "secondary"
	if legacyRoles {
		primary, secondary = "master", "slave"
	}
	body := fmt.Sprintf("[%s]\n\tpassword = %s\n\tupsmon %s\n\n", MonitorUser, quote(users.MonitorPassword), secondary) +
		fmt.Sprintf("[%s]\n\tpassword = %s\n\tactions = SET\n\tinstcmds = ALL\n\tupsmon %s\n",
			AdminUser, quote(users.AdminPassword), primary)
	return withBlock(current, body)
}

// RenderUpsmonConf makes upsmon on this host watch every UPS, or removes WolUPS's lines when it should not.
func RenderUpsmonConf(current string, names []string, users Users, enabled, legacyRoles bool) string {
	if !enabled {
		return withBlock(current, "")
	}
	role := "primary"
	if legacyRoles {
		role = "master"
	}
	var body strings.Builder
	for _, name := range names {
		fmt.Fprintf(&body, "MONITOR %s@localhost 1 %s %s %s\n", name, AdminUser, quote(users.AdminPassword), role)
	}
	return withBlock(current, body.String())
}

var modeLine = regexp.MustCompile(`(?m)^\s*MODE\s*=.*$`)

// RenderNutConf sets MODE=netserver so upsd serves the network.
func RenderNutConf(current string) string {
	if modeLine.MatchString(current) {
		return modeLine.ReplaceAllString(current, "MODE=netserver")
	}
	if current != "" && !strings.HasSuffix(current, "\n") {
		current += "\n"
	}
	return current + "MODE=netserver\n"
}
