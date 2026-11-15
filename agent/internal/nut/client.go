package nut

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
)

// Client speaks the NUT network protocol to upsd. The agent uses it on localhost, so passwords never appear on a
// command line.
type Client struct {
	conn   net.Conn
	reader *bufio.Reader
}

// Dial connects to upsd.
func Dial(ctx context.Context, addr string) (*Client, error) {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	return &Client{conn: conn, reader: bufio.NewReader(conn)}, nil
}

// Command sends one line and returns the reply, or an error for an ERR reply.
func (c *Client) Command(line string) (string, error) {
	if _, err := fmt.Fprintf(c.conn, "%s\n", line); err != nil {
		return "", err
	}
	reply, err := c.reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	reply = strings.TrimSpace(reply)
	if code, ok := strings.CutPrefix(reply, "ERR "); ok {
		return "", fmt.Errorf("NUT error %s", code)
	}
	return reply, nil
}

func (c *Client) Close() error {
	_, _ = fmt.Fprint(c.conn, "LOGOUT\n")
	return c.conn.Close()
}

var (
	cmdNamePattern = regexp.MustCompile(`^[a-z0-9._]{1,64}$`)
	setValue       = regexp.MustCompile(`^[A-Za-z0-9._:/@-]{1,128}$`)
)

func (c *Client) login(user, password string) error {
	if _, err := c.Command(fmt.Sprintf("USERNAME %q", user)); err != nil {
		return err
	}
	_, err := c.Command(fmt.Sprintf("PASSWORD %q", password))
	return err
}

// InstCmd runs an instant command on a UPS as the given user.
func InstCmd(ctx context.Context, user, password, ups, command string) error {
	if !upsNamePattern.MatchString(ups) || !cmdNamePattern.MatchString(command) {
		return errors.New("invalid UPS or command name")
	}
	client, err := Dial(ctx, fmt.Sprintf("127.0.0.1:%d", NUTPort))
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.login(user, password); err != nil {
		return err
	}
	_, err = client.Command(fmt.Sprintf("INSTCMD %s %s", ups, command))
	return err
}

// SetVar sets a writable variable on a UPS as the given user.
func SetVar(ctx context.Context, user, password, ups, name, value string) error {
	if !upsNamePattern.MatchString(ups) || !cmdNamePattern.MatchString(name) || !setValue.MatchString(value) {
		return errors.New("invalid UPS, variable or value")
	}
	client, err := Dial(ctx, fmt.Sprintf("127.0.0.1:%d", NUTPort))
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.login(user, password); err != nil {
		return err
	}
	_, err = client.Command(fmt.Sprintf("SET VAR %s %s %q", ups, name, value))
	return err
}
