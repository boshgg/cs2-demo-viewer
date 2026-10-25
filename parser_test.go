package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestTimelineClockPreservesElapsedTimeAcrossTickReset(t *testing.T) {
	var clock timelineClock
	// Starting in the middle of a recording must not create a long empty lead-in.
	// A reset must preserve the elapsed portion without moving playback backward.
	for i, step := range []struct{ raw, want float64 }{
		{100, 0}, {100.5, 0.5}, {3, 0.5}, {3.25, 0.75}, {4.25, 1.75},
	} {
		if got := clock.at(step.raw); math.Abs(got-step.want) > 1e-9 {
			t.Fatalf("step %d: clock.at(%v) = %v, want %v", i, step.raw, got, step.want)
		}
	}
}

func TestRoundedProducesJSONSafeCoordinates(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 123.456, -123.456} {
		got := rounded(value)
		if _, err := json.Marshal(got); err != nil {
			t.Fatalf("rounded(%v) cannot be serialized: %v", value, err)
		}
		if !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(got-value) > .005001 {
			t.Errorf("rounded(%v) = %v loses more than 0.005 world units", value, got)
		}
	}
}

func TestParseDemoRejectsInvalidHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "invalid.dem")
	if err := os.WriteFile(path, []byte("This is not a Counter-Strike demo file."), 0600); err != nil {
		t.Fatal(err)
	}
	// An unrecovered parser panic fails this test as well as a missing error.
	data, err := parseDemo(context.Background(), path, "invalid", "invalid.dem", func(float64) {})
	if err == nil || data != nil {
		t.Fatalf("invalid input returned data=%v, err=%v; want no data and an error", data, err)
	}
}

// CS2_TEST_DEMO should point to the upstream demoparser Mirage fixture:
// https://raw.githubusercontent.com/LaihoE/demoparser/main/src/parser/test_demo.dem
// SHA256: 84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2
func TestParseDemoRealMirageFixture(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("set CS2_TEST_DEMO to the real Mirage fixture to run integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	data, err := parseDemo(ctx, path, "real-fixture", filepath.Base(path), func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	if data.Map != "de_mirage" || len(data.Rounds) != 10 || len(data.Players) != 10 {
		t.Fatalf("unexpected fixture: map=%q rounds=%d players=%d", data.Map, len(data.Rounds), len(data.Players))
	}
	if len(data.Frames) < 1000 || data.Duration < 800 || data.Duration > 1000 {
		t.Fatalf("incomplete replay: frames=%d duration=%v", len(data.Frames), data.Duration)
	}
	if data.Frames[0].T != 0 || data.Frames[len(data.Frames)-1].T != data.Duration {
		t.Fatalf("frame bounds do not span the replay: first=%v last=%v duration=%v", data.Frames[0].T, data.Frames[len(data.Frames)-1].T, data.Duration)
	}
	for i, frame := range data.Frames {
		if i > 0 && frame.T <= data.Frames[i-1].T {
			t.Fatalf("frames are not strictly increasing at %d: %v then %v", i, data.Frames[i-1].T, frame.T)
		}
		if frame.Round < 1 || frame.Round > len(data.Rounds) {
			t.Fatalf("frame %d references unknown round %d", i, frame.Round)
		}
	}
	for i, round := range data.Rounds {
		if round.Number != i+1 || round.Start < 0 || round.End <= round.Start || round.End > data.Duration {
			t.Fatalf("invalid round %d: %+v; duration=%v", i, round, data.Duration)
		}
		if i > 0 && round.Start != data.Rounds[i-1].End {
			t.Fatalf("round boundary gap/overlap: previous=%+v current=%+v", data.Rounds[i-1], round)
		}
	}
	kills := 0
	for i, event := range data.Events {
		if event.T < 0 || event.T > data.Duration {
			t.Fatalf("event %d is unreachable: time=%v duration=%v type=%s", i, event.T, data.Duration, event.Type)
		}
		if i > 0 && event.T < data.Events[i-1].T {
			t.Fatalf("event %d moves backward in time", i)
		}
		if event.Type == "kill" {
			kills++
		}
	}
	if kills != 73 {
		t.Errorf("kill count=%d, want 73 for the complete fixture", kills)
	}
	// Steam IDs exceed JavaScript's safe integer range and must survive JSON as strings.
	encoded, err := json.Marshal(data.Players)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for i, player := range decoded {
		id, ok := player["id"].(string)
		if !ok || id != data.Players[i].ID {
			t.Fatalf("Steam ID lost its string representation: %#v", player["id"])
		}
		if value, err := strconv.ParseUint(id, 10, 64); err != nil || value <= 1<<53 {
			t.Fatalf("invalid fixture Steam ID %q: %v", id, err)
		}
	}

	t.Run("pre-canceled context", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		data, err := parseDemo(ctx, path, "canceled", filepath.Base(path), func(float64) {})
		if !errors.Is(err, context.Canceled) || data != nil {
			t.Fatalf("canceled parse returned data=%v, err=%v", data, err)
		}
	})
}
