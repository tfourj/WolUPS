package core

import (
	"log"
	"time"
)

// repeatLog prints a message the first time it appears, then only a summary every interval
// while the same message keeps repeating. It keeps journald quiet during long outages.
type repeatLog struct {
	interval time.Duration
	now      func() time.Time
	last     string
	count    int
	loggedAt time.Time
}

func newRepeatLog(interval time.Duration) *repeatLog {
	return &repeatLog{interval: interval, now: time.Now}
}

// Print logs msg unless it repeats the previous message within the interval.
// It returns true when a line was written.
func (r *repeatLog) Print(msg string) bool {
	now := r.now()
	if msg != r.last {
		r.last, r.count, r.loggedAt = msg, 1, now
		log.Print(msg)
		return true
	}
	r.count++
	if now.Sub(r.loggedAt) < r.interval {
		return false
	}
	log.Printf("%s (repeated %d times)", msg, r.count)
	r.count, r.loggedAt = 0, now
	return true
}

// Reset forgets the last message, so the next failure is logged right away.
func (r *repeatLog) Reset() {
	r.last, r.count = "", 0
}
