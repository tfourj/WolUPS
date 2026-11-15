package core

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	maxLineLength   = 500
	maxBatchLines   = 50
	progressDelay   = 250 * time.Millisecond
	outputTailLines = 200
)

var exitProcess = os.Exit

// Output sends a running command's output lines to the server as progress messages, at most four times a second
// and 50 lines at a time. Secrets registered with Mask never leave the agent.
type Output struct {
	id   string
	send func(any) error

	mu      sync.Mutex
	pending []string
	tail    []string
	secrets []string
	timer   *time.Timer
}

func newOutput(id string, send func(any) error) *Output {
	return &Output{id: id, send: send}
}

// Mask replaces secret with *** in every later line.
func (o *Output) Mask(secret string) {
	if secret == "" {
		return
	}
	o.mu.Lock()
	o.secrets = append(o.secrets, secret)
	o.mu.Unlock()
}

// Line queues one output line.
func (o *Output) Line(line string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	line = strings.TrimRight(line, "\r\n")
	for _, secret := range o.secrets {
		line = strings.ReplaceAll(line, secret, "***")
	}
	if len(line) > maxLineLength {
		line = line[:maxLineLength]
	}
	o.pending = append(o.pending, line)
	o.tail = append(o.tail, line)
	if len(o.tail) > outputTailLines {
		o.tail = o.tail[len(o.tail)-outputTailLines:]
	}
	if len(o.pending) >= maxBatchLines {
		o.flushLocked()
		return
	}
	if o.timer == nil {
		o.timer = time.AfterFunc(progressDelay, o.Flush)
	}
}

// Flush sends queued lines now.
func (o *Output) Flush() {
	if o == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.flushLocked()
}

func (o *Output) flushLocked() {
	if o.timer != nil {
		o.timer.Stop()
		o.timer = nil
	}
	if len(o.pending) == 0 || o.send == nil {
		o.pending = nil
		return
	}
	lines := o.pending
	o.pending = nil
	_ = o.send(progressMsg{Type: "progress", ID: o.id, Lines: lines})
}

// Tail is the last lines written, already masked.
func (o *Output) Tail() []string {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.tail...)
}

// Exec runs a command and writes its stdout and stderr line by line.
func (o *Output) Exec(ctx context.Context, name string, args ...string) error {
	_, err := o.ExecCapture(ctx, name, args...)
	return err
}

// ExecCapture runs a command, writes its stdout and stderr line by line and also returns its stdout.
func (o *Output) ExecCapture(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive", "LC_ALL=C")
	var stdout strings.Builder
	var wg sync.WaitGroup
	stream := func(capture *strings.Builder) io.WriteCloser {
		reader, writer := io.Pipe()
		wg.Add(1)
		go func() {
			defer wg.Done()
			scanner := bufio.NewScanner(reader)
			scanner.Buffer(make([]byte, 64*1024), 1024*1024)
			for scanner.Scan() {
				if capture != nil {
					capture.WriteString(scanner.Text())
					capture.WriteByte('\n')
				}
				o.Line(scanner.Text())
			}
			_, _ = io.Copy(io.Discard, reader)
		}()
		return writer
	}
	outWriter, errWriter := stream(&stdout), stream(nil)
	cmd.Stdout = outWriter
	cmd.Stderr = errWriter
	err := cmd.Run()
	outWriter.Close()
	errWriter.Close()
	wg.Wait()
	return stdout.String(), err
}
