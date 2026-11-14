package main

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
)

func utilityTimingFixture() *DemoData {
	d := &DemoData{ID: "timing", Name: "timing.dem", Map: "de_mirage", Duration: 130, Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 10, End: 130}}}
	for i, elapsed := range []float64{0, 5, 5.001, 20, 20.001, 50, 50.001} {
		d.Utilities = append(d.Utilities, Utility{ID: fmt.Sprintf("utility-%d", i), Type: "smoke", OwnerID: analysisTestID(1), Owner: "thrower", Team: 2, Round: 1, Start: 10 + elapsed, Detonate: 16 + elapsed, Detonated: true, ThrowObserved: true, X: 100, Y: 200, Path: []UtilityPoint{{T: 10 + elapsed, X: 10, Y: 20}}})
	}
	d.Utilities = append(d.Utilities, Utility{ID: "landing-only", Type: "flash", OwnerID: analysisTestID(1), Owner: "thrower", Team: 2, Round: 1, Start: 18, Detonate: 25, Detonated: true, ThrowObserved: false, X: 100, Y: 200})
	return d
}

func TestAnalysisUtilityTimingUsesThrowRatherThanLanding(t *testing.T) {
	d := utilityTimingFixture()
	a := BuildAnalysis(d)
	if a.UtilityTimingVersion != 1 || len(a.Utilities) != len(d.Utilities) {
		t.Fatal("timing marker missing or existing utility population changed")
	}
	byID := map[string]AnalysisUtility{}
	for _, utility := range a.Utilities {
		byID[utility.ID] = utility
	}
	for i, elapsed := range []float64{0, 5, 5.001, 20, 20.001, 50, 50.001} {
		got := byID[fmt.Sprintf("utility-%d", i)]
		if got.RoundElapsed == nil || math.Abs(*got.RoundElapsed-elapsed) > 1e-9 || got.TimeSource != "freeze_end" || got.Time != d.Utilities[i].Start {
			t.Fatalf("throw time %g became %+v", elapsed, got)
		}
	}
	unknown := byID["landing-only"]
	if unknown.RoundElapsed != nil || unknown.TimeSource != "unknown" || unknown.Time != 25 {
		t.Fatal("landing time was silently interpreted as a throw")
	}
	body, err := json.Marshal(unknown)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	json.Unmarshal(body, &raw)
	if string(raw["roundElapsed"]) != "null" {
		t.Fatal("unknown time must be explicit null, not zero or a missing field")
	}
}

func TestAnalysisUtilityTimingRequiresAnObservedValidAnchor(t *testing.T) {
	base := Round{Number: 1, Start: 0, FreezeEnd: 10, End: 130}
	observed := Utility{Round: 1, Start: 15, Detonate: 50, ThrowObserved: true}
	for _, test := range []struct {
		name    string
		round   Round
		utility Utility
	}{
		{"freeze period", base, Utility{Round: 1, Start: 9.999, Detonate: 50, ThrowObserved: true}},
		{"no observed throw", base, Utility{Round: 1, Start: 15, Detonate: 50}},
		{"non-finite throw", base, Utility{Round: 1, Start: math.NaN(), ThrowObserved: true}},
		{"missing freeze event", Round{Number: 1, Start: 0, FreezeEnd: 0, End: 130}, observed},
		{"default freeze equals start", Round{Number: 1, Start: 10, FreezeEnd: 10, End: 130}, observed},
		{"freeze before round", Round{Number: 1, Start: 10, FreezeEnd: 5, End: 130}, observed},
		{"freeze after round", Round{Number: 1, Start: 0, FreezeEnd: 140, End: 130}, observed},
		{"non-finite anchor", Round{Number: 1, Start: 0, FreezeEnd: math.NaN(), End: 130}, observed},
		{"throw after round", base, Utility{Round: 1, Start: 131, ThrowObserved: true}},
		{"missing round", base, Utility{Round: 2, Start: 15, ThrowObserved: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			elapsed, source := analysisUtilityTiming(test.utility, analysisTimingRounds([]Round{test.round}))
			if elapsed != nil || source != "unknown" {
				t.Fatalf("invalid timing evidence was accepted: %v %s", elapsed, source)
			}
		})
	}
	if elapsed, source := analysisUtilityTiming(observed, analysisTimingRounds([]Round{base, base})); elapsed != nil || source != "unknown" {
		t.Fatal("ambiguous duplicate round was used as an anchor")
	}
	exactZero := Round{Number: 1, Start: 0, FreezeEnd: 0, End: 130, Economy: &EconomySnapshot{Source: "freeze_end", Time: 0}}
	if elapsed, source := analysisUtilityTiming(Utility{Round: 1, Start: 0, ThrowObserved: true}, analysisTimingRounds([]Round{exactZero})); elapsed == nil || *elapsed != 0 || source != "freeze_end" {
		t.Fatal("a genuinely observed zero-second freeze end was discarded")
	}
}
