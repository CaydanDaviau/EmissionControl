# Tuning guide

Values you can change by hand. Everything in `sim.js` lives in the `CFG` object at the top (`Sim.CFG`). Units: nm, kt, seconds, degrees. "real s" = real time (not scaled by the Time button); "sim s" = scaled by the Time button.

## Movement (`sim.js`, `CFG`)
| Key | Value | Meaning |
|---|---|---|
| `FLANK` | 30 kt | top speed |
| `CRUISE` | 15 kt | formation/patrol speed |
| `REVERSE` | -8 kt | astern speed |
| `ACCEL` | 0.5 kt/sim s | acceleration |
| `TURN` | 3 deg/sim s | turn rate at full steering speed |
| `TURN_FULL_AT` | 8 kt | speed for 100% turn rate |
| `TURN_MIN` | 0.2 | fraction of turn rate when slow/stopped |
| `ALLY.OFFSET` | 15 nm | ally escort slot abeam (starboard) |
| `DAMAGE.DRIFT_DECEL` | 1 kt/s | destroyed ship slows down |

## Sensors (`sim.js`, `CFG`)
| Key | Value | Meaning |
|---|---|---|
| `RADAR.RANGE` | 70 nm | radar range (ours; enemy uses `emit.range`, set in `index.html`) |
| `RADAR.HORIZON` | 32 nm | hard detection cap for radar |
| `RADAR.PERIOD` | 4 s | sweep period |
| `RADAR.RCS_REF` | 10000 m2 | reference RCS (normal ship) |
| `RADAR.Q_HIT` / `Q_MISS` / `Q_DROP` | 0.35 / 0.08 / 0.10 | track quality gain on hit, loss on miss, drop threshold |
| `RADAR.H_ANT` | 100 ft | unused |
| `ESM.RANGE_FACTOR` | 2 | ESM range = this x emitter radar range |
| `ESM.DUCT` | 1.3 | ESM cap = `RADAR.HORIZON` x this (~41.6 nm) |
| `ESM.SIGMA` | 10 deg | bearing error (drives FIX accuracy) |
| `ESM.INTERVAL` | 2 s | ESM roll interval |
| `ESM.HOLD` | 15 s | how long a bearing is kept |
| `ESM.H_ANT` | 100 ft | unused |
| `IDENTIFY.TIME` | 20 s | identify time at `D_REF` for a normal ship |
| `IDENTIFY.D_REF` | 10 nm | reference distance |
| `IDENTIFY.MIN` / `MAX` | 5 / 90 s | clamp |
| `LINK.EMIT` | 25 nm | how far LINK emission can be heard |
| `FIX.LIFE` | 5 s | ESM fix marker lifetime |
| `FIX.FRESH` | 2.5 s | max age of the bearings used |
| `FIX.MIN_SIN` | 0.05 | min crossing angle (sine); lower = accepts shallow crossings |
| `FIX.MAXR` | 120 nm | max fix distance |

## Weapons and damage (`sim.js`, `CFG`)
| Key | Value | Meaning |
|---|---|---|
| `WEAPON.COUNTDOWN` | 5 s | launch countdown (real s) |
| `WEAPON.ARRIVE` | 0.5 nm | arrival radius |
| `WEAPON.SEEKER` | 5 nm | unused (per-weapon `seeker` replaced it) |
| `WEAPONS.ssm` | range 70, speed 480, turn 10, seeker 5 | SSM (RGM-84) |
| `WEAPONS.asm` | range 150, speed 500, turn 8, seeker 10 | ASM (LRASM) |
| `DAMAGE.P_HIT` | 0.9 | hit chance on arrival |
| `DAMAGE.SSM.second` | 0.15 | chance to destroy a 2nd station (never NAV) |
| `DAMAGE.ASM.second` | 0.55 | chance of a 2nd station (NAV allowed) |
| `DAMAGE.DEBUG_DIST` | 20 nm | debug missile start distance |

Loadout (ammo per ship): `newLoadout` in `sim.js`, currently 8 SSM + 4 ASM. Same for player, ally and enemies.

## Defense (`sim.js`, `CFG.DEFENSE`, same numbers for player, enemy and ally)
| Key | Value | Meaning |
|---|---|---|
| `DECOY.P` | 0.2 | seduce chance per missile per deploy |
| `DECOY.AMMO` | 4 | decoys |
| `DECOY.CD` | 20 s | reload |
| `DECOY.RANGE` | 4 nm | only missiles this close can be seduced |
| `CIWS.RANGE` | 1 nm | engagement range |
| `CIWS.P` | 0.1 per real s | kill chance (one target at a time) |
| `SAM.RANGE` | 25 nm | launch range |
| `SAM.P` | 0.5 | kill chance |
| `SAM.AMMO` | 16 | SAMs |
| `SAM.SPEED` | 2000 kt | flight speed |
| `SAM.RELOAD` | 20 s | one reload timer per ship |
| `ECM.RANGE` | 20 nm | jams missiles inside this |
| `ECM.P` | 0.06 per real s | jam chance per missile |
| `ECM.EMIT` | 40 nm | enemy ESM hears our ECM at this emitter range |
| `X_TIME` | 10 s | how long a destroyed missile's X stays |
| `STRAY` | 60 nm | decoyed/jammed missile removed beyond this |

Rules (not numbers): decoy, ECM and CIWS act on SSMs only; SAMs go at ASMs first, then SSMs.

## Enemy and ally AI (`sim.js`, `CFG.AI`)
| Key | Value | Meaning |
|---|---|---|
| `DUTY_PERIOD` | 60 s | radar cycle length |
| `DUTY_ON` | 20 s | radar on per cycle |
| `SWEEP` | 4 s | detection roll interval while radar on |
| `SHIP_RCS` | 10000 | RCS the AI assumes for ships |
| `COAST` | 0.02 q/s | track decay while its radar is silent |
| `TURN` | 3 deg/s | AI turn rate |
| `WP_NM` | 1 nm | waypoint switch radius |
| `FIRE_Q` | 0.5 | min track quality to fire |
| `FIRE_CD` | 30 s | seconds between launches |
| `FIX_CD` | 180 s | one probing shot at an ESM fix per this time |
| `HOLD` | 0.8 | keeps us at this x its radar range (56 nm at range 70) |
| `BAND` | 4 nm | +/- band around the hold distance |
| `GIVE_UP` | 180 s | no track for this long, back to patrol |
| `INV_HOLD` | 60 s | keeps investigating after the ESM bearing stops |
| `REACT_MIN` / `REACT_MAX` | 2 / 5 s | defense reaction delay |
| `SHIP_H`, `H_ANT` | 60 / 100 ft | unused |

## Hardcoded in `index.html`
| Where | Value | Meaning |
|---|---|---|
| `const EDGE` | 40 nm | enemy 1 spawn distance (due north) |
| `contacts = [mkEnemy(...)]` | enemy 2 at 070 deg, 38 nm | spawns; `mkEnemy(id, brg, R, aiSeed, seed)` |
| `mkEnemy` | `emit {Type 346B, range 70}`, speed 15 | enemy radar name/range, start speed |
| `mkEnemy` waypoints | +-10 east, +2..+14 north of spawn | patrol box |
| `Sim.newAlly(15,0)` and reset | 15, 0 | ally start position (two places, incl. debug reset) |
| `const RANGES` | 5,10,20,40,70,100,150,200,300 | scope range steps |
| `const TS` | 1, 5, 20 | Time button steps |
| `bannerT = 8` | 8 s | hit/strike banner duration |
| `setTimeout(...,400)` / `setInterval(fn,60)` | 400 / 60 ms | heading arrow hold-repeat |
| `LAT0`, `LON0` | 41 deg 11.295 N, 21 deg 26.496 E | start position |

Seeds (`aiSeed`, `seed`, `newEsm(20261113)`) are in the same `mkEnemy`/`contacts` lines: change them to get different dice.
