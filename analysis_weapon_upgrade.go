package main

import "context"

// Current replay caches serialize rounds before frames. Accumulate equipment in
// the metadata pass; older or reordered JSON can place an observation earlier,
// in which case replay it once the round boundaries are known.
func readAnalysisWeaponReplay(ctx context.Context, path string, replay *analysisTimingReplay) (*analysisRoundWeapons, error) {
	var weapons *analysisRoundWeapons
	observationsBeforeRounds := false
	ready := func() bool {
		if weapons == nil {
			if replay.Rounds == nil {
				observationsBeforeRounds = true
				return false
			}
			weapons = newAnalysisRoundWeapons(replay.Rounds)
		}
		return true
	}
	visit := analysisReplayVisitor{
		frame: func(f Frame) {
			if ready() {
				weapons.observeFrame(f)
			}
		},
		shot: func(s Shot) {
			if ready() {
				weapons.observeShot(s)
			}
		},
		damage: func(e DamageEvent) {
			if ready() {
				weapons.observeDamage(e)
			}
		},
	}
	if err := streamAnalysisReplayWithVisitor(ctx, path, replay, visit); err != nil {
		return nil, err
	}
	if weapons == nil || observationsBeforeRounds {
		weapons = newAnalysisRoundWeapons(replay.Rounds)
	}
	if observationsBeforeRounds && len(replay.Rounds) > 0 {
		visit = analysisReplayVisitor{frame: weapons.observeFrame, shot: weapons.observeShot, damage: weapons.observeDamage}
		if err := streamAnalysisReplayWithVisitor(ctx, path, nil, visit); err != nil {
			return nil, err
		}
	}
	for _, event := range replay.Events {
		weapons.observeEvent(event)
	}
	return weapons, nil
}
