package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestLegacyUtilityWeaponsUpgradeFromReplay(t *testing.T) {
	for _, reordered := range []bool{false, true} {
		name := "canonical-order"
		if reordered {
			name = "frames-before-rounds"
		}
		t.Run(name, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			j, replay, _ := legacyAnalysisFixture(t, a, "000000000000000000000026")
			owner := "local:bot-7"
			for i := range replay.Utilities {
				replay.Utilities[i].OwnerID = owner
			}
			replay.Frames = []Frame{{T: 16, Round: 1, Players: []PlayerFrame{
				{ID: owner, Team: 2, Alive: true, Connected: true, Weapon: "Smoke Grenade", Weapons: []WeaponItem{{Name: "AK-47", Slot: "primary"}}},
			}}}
			replay.Shots = []Shot{{Round: 1, T: 17, PlayerID: analysisTestID(3), Weapon: "AWP"}}
			fresh := BuildAnalysis(replay)
			if got := fresh.Utilities[0].RoundBestWeapon; got != "AK-47" {
				t.Fatalf("fresh round equipment = %q", got)
			}
			body, err := json.Marshal(fresh)
			if err != nil {
				t.Fatal(err)
			}
			var summary map[string]json.RawMessage
			if err := json.Unmarshal(body, &summary); err != nil {
				t.Fatal(err)
			}
			delete(summary, "utilityWeaponVersion")
			var rows []map[string]json.RawMessage
			if err := json.Unmarshal(summary["utilities"], &rows); err != nil {
				t.Fatal(err)
			}
			for _, row := range rows {
				delete(row, "roundBestWeapon")
				row["customTag"] = json.RawMessage(`"keep"`)
			}
			// A row with the right grenade ID but a different recorded thrower
			// must not acquire another player's equipment.
			rows[1]["playerId"], _ = json.Marshal(analysisTestID(3))
			summary["utilities"], _ = json.Marshal(rows)
			writeFixtureGzip(t, j.analysisResult, summary)
			legacyHash := fileHash(t, j.analysisResult)
			if reordered {
				body, err = json.Marshal(replay)
				if err != nil {
					t.Fatal(err)
				}
				var raw map[string]json.RawMessage
				if err := json.Unmarshal(body, &raw); err != nil {
					t.Fatal(err)
				}
				writeFixtureGzip(t, j.result, raw) // Sorted keys put frames before rounds.
			} else {
				writeFixtureGzip(t, j.result, replay)
			}
			replayHash := fileHash(t, j.result)
			get := func() map[string]json.RawMessage {
				return readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			}
			next := get()
			if string(next["utilityWeaponVersion"]) != "1" || fileHash(t, j.result) != replayHash || fileHash(t, j.analysisResult) == legacyHash {
				t.Fatal("weapon upgrade did not persist only the derived summary")
			}
			if err := json.Unmarshal(next["utilities"], &rows); err != nil {
				t.Fatal(err)
			}
			for i, row := range rows {
				want := `"AK-47"`
				if i == 1 {
					want = ""
				}
				if string(row["roundBestWeapon"]) != want || string(row["customTag"]) != `"keep"` {
					t.Errorf("upgraded utility %d: weapon %s tag %s", i, row["roundBestWeapon"], row["customTag"])
				}
			}
			// Once persisted the value survives replay cache unavailability.
			if err := os.Remove(j.result); err != nil {
				t.Fatal(err)
			}
			if got := get(); string(got["utilities"]) != string(next["utilities"]) {
				t.Fatal("formerly upgraded weapons changed on the next read")
			}
			// An unavailable replay must leave a legacy summary intact and retryable.
			writeFixtureGzip(t, j.analysisResult, summary)
			badHash := fileHash(t, j.analysisResult)
			if got := get(); len(got["utilityWeaponVersion"]) != 0 || fileHash(t, j.analysisResult) != badHash {
				t.Fatal("failed weapon upgrade changed legacy file or version")
			}
			writeFixtureGzip(t, j.result, replay)
			if got := get(); string(got["utilityWeaponVersion"]) != "1" {
				t.Fatal("weapon upgrade did not retry when replay returned")
			}
		})
	}
}
