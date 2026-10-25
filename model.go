package main

type DemoData struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Map        string       `json:"map"`
	TickRate   float64      `json:"tickRate"`
	Duration   float64      `json:"duration"`
	SampleRate int          `json:"sampleRate"`
	Players    []PlayerInfo `json:"players"`
	Rounds     []Round      `json:"rounds"`
	Frames     []Frame      `json:"frames"`
	Events     []Event      `json:"events"`
	Shots      []Shot       `json:"shots"`
	Utilities  []Utility    `json:"utilities"`
	Warnings   []string     `json:"warnings"`
	Synthetic  bool         `json:"synthetic,omitempty"`
}

type PlayerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Team int    `json:"team"`
}

type PlayerFrame struct {
	ID        string          `json:"id"`
	X         float64         `json:"x"`
	Y         float64         `json:"y"`
	Z         float64         `json:"z"`
	Yaw       float64         `json:"yaw"`
	HP        int             `json:"hp"`
	Armor     int             `json:"armor"`
	Team      int             `json:"team"`
	Alive     bool            `json:"alive"`
	Weapon    string          `json:"weapon"`
	Weapons   []WeaponItem    `json:"weapons"`
	HasBomb   bool            `json:"hasBomb"`
	Connected bool            `json:"connected"`
	Inventory []InventoryItem `json:"inventory"`
	Ammo      int             `json:"ammo"`
	Reserve   int             `json:"reserve"`
	Money     int             `json:"money"`
	Helmet    bool            `json:"helmet"`
	DefuseKit bool            `json:"defuseKit"`
	Flash     float64         `json:"flash"`
	Scoped    bool            `json:"scoped"`
	Crouching bool            `json:"crouching"`
}

// Weapon is the active item; Weapons is the carried firearm loadout. Grenades
// remain in Inventory so their counts are not confused with weapon slots.
type WeaponItem struct {
	Name   string `json:"name"`
	Slot   string `json:"slot"`
	Active bool   `json:"active"`
}

// Shot is an observed weapon_fire event, not a simulated bullet or hit ray.
type Shot struct {
	T        float64 `json:"t"`
	Round    int     `json:"round"`
	PlayerID string  `json:"playerId"`
	Team     int     `json:"team"`
	Weapon   string  `json:"weapon"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Z        float64 `json:"z"`
	Yaw      float64 `json:"yaw"`
}

type InventoryItem struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

type UtilityPoint struct {
	T      float64 `json:"t"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
	Bounce bool    `json:"bounce,omitempty"`
}

type FireFrame struct {
	T      float64    `json:"t"`
	Points []Position `json:"points"`
}

// Utility follows one physical grenade across its flight and effect lifetime.
// Path and fireFrames are recorded world coordinates, not simulated trajectories.
type Utility struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	OwnerID        string         `json:"ownerId"`
	Owner          string         `json:"owner"`
	Team           int            `json:"team"`
	Round          int            `json:"round"`
	Start          float64        `json:"start"`
	End            float64        `json:"end"`
	Detonate       float64        `json:"detonate"`
	Detonated      bool           `json:"detonated"`
	X              float64        `json:"x"`
	Y              float64        `json:"y"`
	Z              float64        `json:"z"`
	Path           []UtilityPoint `json:"path"`
	FireFrames     []FireFrame    `json:"fireFrames,omitempty"`
	BurnObserved   bool           `json:"burnObserved,omitempty"`
	BurnStart      float64        `json:"burnStart,omitempty"`
	EndObserved    bool           `json:"endObserved"`
	ThrowObserved  bool           `json:"throwObserved"`
	SourceInferred bool           `json:"sourceInferred,omitempty"`
	Approx         bool           `json:"approx"`
}

type Grenade struct {
	ID      string  `json:"id"`
	Type    string  `json:"type"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Z       float64 `json:"z"`
	OwnerID string  `json:"ownerId,omitempty"`
	Owner   string  `json:"owner,omitempty"`
	Team    int     `json:"team,omitempty"`
}

type Bomb struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	State string  `json:"state"`
}

type Frame struct {
	T        float64       `json:"t"`
	Round    int           `json:"round"`
	CTScore  int           `json:"ctScore"`
	TScore   int           `json:"tScore"`
	CTName   string        `json:"ctName,omitempty"`
	TName    string        `json:"tName,omitempty"`
	Players  []PlayerFrame `json:"players"`
	Grenades []Grenade     `json:"grenades"`
	Bomb     *Bomb         `json:"bomb,omitempty"`
}

type Round struct {
	Number    int     `json:"number"`
	Start     float64 `json:"start"`
	End       float64 `json:"end"`
	Winner    int     `json:"winner"`
	Reason    string  `json:"reason"`
	FreezeEnd float64 `json:"freezeEnd"`
	EndedAt   float64 `json:"endedAt"`
	CTScore   int     `json:"ctScore"`
	TScore    int     `json:"tScore"`
	TimeLimit int     `json:"timeLimit,omitempty"`
}

type Event struct {
	T             float64   `json:"t"`
	Type          string    `json:"type"`
	Killer        string    `json:"killer,omitempty"`
	Victim        string    `json:"victim,omitempty"`
	KillerID      string    `json:"killerId,omitempty"`
	VictimID      string    `json:"victimId,omitempty"`
	Weapon        string    `json:"weapon,omitempty"`
	Headshot      bool      `json:"headshot,omitempty"`
	Text          string    `json:"text,omitempty"`
	Round         int       `json:"round"`
	Assister      string    `json:"assister,omitempty"`
	AssisterID    string    `json:"assisterId,omitempty"`
	KillerTeam    int       `json:"killerTeam,omitempty"`
	VictimTeam    int       `json:"victimTeam,omitempty"`
	Penetrated    int       `json:"penetrated,omitempty"`
	NoScope       bool      `json:"noScope,omitempty"`
	ThroughSmoke  bool      `json:"throughSmoke,omitempty"`
	AttackerBlind bool      `json:"attackerBlind,omitempty"`
	AssistedFlash bool      `json:"assistedFlash,omitempty"`
	KillerPos     *Position `json:"killerPos,omitempty"`
	VictimPos     *Position `json:"victimPos,omitempty"`
	UtilityID     string    `json:"utilityId,omitempty"`
	OwnerID       string    `json:"ownerId,omitempty"`
	Owner         string    `json:"owner,omitempty"`
	Team          int       `json:"team,omitempty"`
	Site          string    `json:"site,omitempty"`
}
