const test = require("node:test"), assert = require("node:assert/strict"), Sim = require("../sim.js");
const run = (fn, secs, dt = 0.1) => { for (let i = 0; i < secs / dt; i++) fn(dt); };
const mk = (b, r, o) => Sim.newContact(1, b, r, o);

test("ESM hears an emitter at 26 nm (no horizon cap); not one far beyond 2x its radar range", () => {
  const ship = Sim.newShip(), esm = Sim.newEsm(1);
  const near = mk(0, 26, { emit: { name: "X", range: 35 } }), far = mk(90, 200, { emit: { name: "X", range: 35 } });
  run(dt => Sim.esmStep(esm, ship, [near, far], dt), 60);
  assert.ok(near.esm, "26 nm heard"); assert.equal(far.esm, null, "200 nm out of ESM range");
  assert.ok(Math.abs(Sim.diff(near.esm.brg, 0)) < 35, "bearing within ~3 sigma (sigma 10)");
});
test("silent emitter is not heard; esm expires after HOLD", () => {
  const ship = Sim.newShip(), esm = Sim.newEsm(2), c = mk(0, 20, { emit: { name: "X", range: 35 } });
  run(dt => Sim.esmStep(esm, ship, [c], dt), 30); assert.ok(c.esm);
  c.emitting = false; run(dt => Sim.esmStep(esm, ship, [c], dt), 20); assert.equal(c.esm, null);
});
test("radar sees a contact; EMCON (radar.on=false) blinds and tracks fade", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(3), c = mk(0, 15);
  run(dt => Sim.radarStep(radar, ship, [c], dt), 60); assert.ok(c.tracked);
  radar.on = false; run(dt => Sim.radarStep(radar, ship, [c], dt), 90);
  assert.equal(c.tracked, false); assert.ok(c.seen, "stays as lost mark at last position");
  radar.on = true; run(dt => Sim.radarStep(radar, ship, [c], dt), 30); assert.ok(c.tracked, "reacquired");
});
test("moving contact advances at its speed", () => {
  const c = mk(0, 10, { course: 180, speed: 30 }); run(dt => Sim.stepContact(c, dt), 360);
  assert.ok(Math.abs(c.y - 7) < 0.01);
});
test("ESM/radar deterministic for a seed", () => {
  const f = () => { const s = Sim.newShip(), e = Sim.newEsm(9), c = mk(30, 24, { emit: { name: "X", range: 35 } }); run(dt => Sim.esmStep(e, s, [c], dt), 40); return c.esm.brg; };
  assert.equal(f(), f());
});

// ---- identify ----
const track = (c, ship, radar) => run(dt => Sim.radarStep(radar, ship, [c], dt), 60);
test("identify completes after TIME with a held track; reveals truth and locks the tag", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(3), c = mk(0, 8, { side: "enemy" });
  track(c, ship, radar); assert.ok(c.tracked && c.cls === "unk");
  assert.ok(Sim.startIdentify(c));
  run(dt => { Sim.radarStep(radar, ship, [c], dt); Sim.identifyStep([c], dt, radar.on, ship); }, Sim.identifyTime(c, ship) + 3);
  assert.ok(c.identified && c.cls === "host" && !c.idActive);
  assert.equal(Sim.setTag(c, "ally"), false, "tag locked");
});
test("EMCON interrupts identify at once and resets progress", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(4), c = mk(0, 8, { side: "enemy" });
  track(c, ship, radar); Sim.startIdentify(c);
  run(dt => { Sim.radarStep(radar, ship, [c], dt); Sim.identifyStep([c], dt, radar.on, ship); }, 8);
  assert.ok(c.idActive && c.idProg > 0.3);
  radar.on = false; // EMCON: interrupts at once, even while the track still coasts
  run(dt => { Sim.radarStep(radar, ship, [c], dt); Sim.identifyStep([c], dt, radar.on, ship); }, 1);
  assert.ok(c.tracked && !c.idActive && c.idProg === 0 && c.idNote === "emcon" && !c.identified);
});
test("identify is interrupted and resets when the track is lost (radar on)", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(6), c = mk(0, 8, { side: "enemy" });
  track(c, ship, radar); Sim.startIdentify(c);
  c.tracked = false; Sim.identifyStep([c], 0.1, true, ship); // track dropped (e.g. contact left detection range)
  assert.ok(!c.idActive && c.idProg === 0 && c.idNote === "lost" && !c.identified);
});
test("identify needs a track; identified tag survives track loss; neutral and ally reveal correctly", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(5), n = mk(0, 8), a = mk(90, 8, { side: "ally" });
  assert.equal(Sim.startIdentify(n), false, "untracked");
  run(dt => Sim.radarStep(radar, ship, [n, a], dt), 60);
  Sim.startIdentify(n); Sim.startIdentify(a);
  run(dt => { Sim.radarStep(radar, ship, [n, a], dt); Sim.identifyStep([n, a], dt, radar.on, ship); }, 25);
  assert.ok(n.identified && n.cls === "unk" && a.identified && a.cls === "ally");
  radar.on = false; run(dt => Sim.radarStep(radar, ship, [n, a], dt), 90);
  assert.ok(!a.tracked && a.identified && a.cls === "ally", "ID persists when lost");
  assert.equal(Sim.startIdentify(a), false, "already identified");
});
test("identify time grows with range and for low-RCS contacts", () => {
  const ship = Sim.newShip(), near = mk(0, 5), far = mk(0, 20), stealth = mk(0, 5, { rcs: 100 });
  const tn = Sim.identifyTime(near, ship), tf = Sim.identifyTime(far, ship), ts = Sim.identifyTime(stealth, ship);
  assert.ok(tf > tn && ts > tn, [tn, tf, ts].join());
  assert.ok(Math.abs(Sim.identifyTime(mk(0, 10), ship) - Sim.CFG.IDENTIFY.TIME) < 1e-9, "20 s at 10 nm, normal RCS");
});

// ---- weapons (SSM launch) ----
const tracked = (b, r, o) => { const s = Sim.newShip(), rd = Sim.newRadar(7), c = mk(b, r, o); run(dt => Sim.radarStep(rd, s, [c], dt), 60); return { s, c, rd }; };
test("fire: 5 s countdown, then launch uses one ammo and spawns a missile", () => {
  const { s, c } = tracked(0, 10), ms = []; assert.ok(c.tracked);
  assert.equal(Sim.fireCheck(s, null, c), "Select a weapon.");
  assert.ok(Sim.startFire(s, 0, c));
  run(dt => Sim.fireStep(s, [c], ms, dt), 4); assert.equal(ms.length, 0); assert.equal(s.loadout[0].ammo, 8);
  run(dt => Sim.fireStep(s, [c], ms, dt), 1.5); assert.equal(ms.length, 1); assert.equal(s.loadout[0].ammo, 7); assert.equal(s.fire, null);
});
test("fire: aborts on lost track, out of range, manual cancel; blocked with no ammo", () => {
  let { s, c } = tracked(0, 10), ms = [];
  Sim.startFire(s, 0, c); c.tracked = false; Sim.fireStep(s, [c], ms, 0.1);
  assert.ok(!s.fire && /not tracked/.test(s.fireMsg) && s.loadout[0].ammo === 8);
  c.tracked = true; Sim.startFire(s, 0, c); c.px = 0; c.py = 80; Sim.fireStep(s, [c], ms, 0.1);
  assert.ok(!s.fire && /Out of range/.test(s.fireMsg));
  c.py = 10; Sim.startFire(s, 0, c); Sim.cancelFire(s); assert.equal(s.fire, null);
  s.loadout[0].ammo = 0; assert.equal(Sim.startFire(s, 0, c), false); assert.equal(Sim.fireCheck(s, 0, c), "No ammo.");
});
test("missile curves toward the last known position and ends there; ammo/ids tracked", () => {
  const { s, c } = tracked(90, 12), ms = []; s.hdg = 0;
  Sim.startFire(s, 0, c); run(dt => Sim.fireStep(s, [c], ms, dt), 6); const m = ms[0];
  assert.equal(m.n, 1); const h0 = m.hdg; run(dt => Sim.stepMissiles(ms, [c], dt), 2); assert.ok(m.hdg > h0, "turns toward east");
  run(dt => Sim.stepMissiles(ms, [c], dt), 300); assert.equal(ms.length, 0, "arrived and removed");
});
test("damage: SSM never hits NAVIGATION, ASM can; sinks at <=1 station left", () => {
  let navSsm = 0, navAsm = 0;
  for (let k = 0; k < 400; k++) {
    const a = Sim.newShip(); a.rng.seed = k; const r = Sim.hitShip(a, "SSM"); if (r.lost.includes(0)) navSsm++;
    assert.ok(r.lost.length <= 2 && (r.hit || !r.lost.length));
    const b = Sim.newShip(); b.rng.seed = k; if (Sim.hitShip(b, "ASM").lost.includes(0)) navAsm++;
  }
  assert.equal(navSsm, 0); assert.ok(navAsm > 20, "ASM hits NAV sometimes");
  const s = Sim.newShip(); s.dead = [false, true, true, false]; s.rng.seed = 5;
  let r; do { r = Sim.hitShip(s, "SSM"); } while (!r.hit);
  assert.ok(s.sunk && r.sunk && s.dead.every(Boolean));
});
test("sunk ship decelerates to a stop, then is a permanent wreck", () => {
  const s = Sim.newShip(); s.spd = s.ordSpd = 15; s.hdg = s.ordHdg = 90;
  s.rng.seed = 1; s.dead = [false, true, true, false]; do { Sim.hitShip(s, "SSM"); } while (!s.sunk);
  run(dt => Sim.step(s, dt), 5); assert.ok(s.spd > 9 && !s.wreck, "drifts, not instant");
  run(dt => Sim.step(s, dt), 200); assert.ok(s.wreck && s.spd === 0);
  const x = s.x; run(dt => Sim.step(s, dt), 10); assert.equal(s.x, x);
});
test("debug missile flies 20 nm to own ship and resolves a hit; weapons station dead blocks fire", () => {
  const s = Sim.newShip(), ms = []; Sim.debugMissile(s, ms, "asm");
  const m = ms[0]; assert.ok(Math.abs(Math.hypot(m.x, m.y) - 20) < 1e-9 && m.side === "enemy" && m.tid === "own");
  run(dt => Sim.stepMissiles(ms, [], dt, s), 200); assert.equal(ms.length, 0); assert.equal(s.hitSeq, 1); assert.ok(/H1 (HIT|MISSED)/.test(s.hitMsg));
  s.dead[2] = true; assert.equal(Sim.fireCheck(s, 0, { tracked: true, px: 0, py: 5 }), "Weapons station destroyed.");
  Sim.resetShip(s); assert.ok(s.dead.every(d => !d) && !s.sunk);
});

test("enemy AI: patrol radar is duty-cycled (1/3 on) with no contact; it detects us and hears our radar when close", () => {
  const S = require("../sim.js"); const ship = S.newShip();
  const far = S.newContact(1, 0, 400, { side: "enemy", speed: 15, emit: { name: "T", range: 35 } });
  far.ai = S.newAi(7, [[10, 23], [10, 35], [-10, 35], [-10, 23]]); far.hdg = 90;
  let on = 0, tot = 0;
  for (let i = 0; i < 600; i++) { S.aiStep(far, ship, true, 1); S.stepContact(far, 1); tot++; if (far.emitting) on++; }
  assert.ok(Math.abs(on / tot - 1 / 3) < 0.02); assert.equal(far.ai.state, "patrol"); assert.equal(far.ai.tracks, false);
  const c = S.newContact(1, 0, 21, { side: "enemy", speed: 15, emit: { name: "T", range: 35 } }); c.ai = S.newAi(7, null);
  let tracked = false, heard = false;
  for (let i = 0; i < 600; i++) { S.aiStep(c, ship, true, 1); tracked = tracked || c.ai.tracks; heard = heard || !!c.ai.hears; }
  assert.ok(tracked); assert.ok(heard);
  const c2 = S.newContact(2, 0, 21, { emit: { name: "T", range: 35 } }); c2.ai = S.newAi(7, [[0, 21]]);
  for (let i = 0; i < 300; i++) S.aiStep(c2, ship, false, 1);
  assert.ok(!c2.ai.hears); // our radar off: not heard
});

test("AI fires only with a good track, one per cooldown; random weapon mix, ASM only beyond SSM range", () => {
  const ship = Sim.newShip(), ms = [], c = mk(0, 20, { side: "enemy" }); c.ai = Sim.newAi(1, null);
  assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "no track, no fire");
  c.ai.tracks = true; c.ai.q = 0.8; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "not engaging (not identified hostile): no fire"); c.ai.state = "engage"; c.ai.tracks = false;
  c.ai.tracks = true; c.ai.q = 0.4; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "track too weak");
  c.ai.q = 0.8; const m1 = Sim.aiFireStep(c, ship, ms, 1);
  assert.ok(m1 && m1.tid === "own" && m1.side === "enemy");
  assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "cooldown");
  const seen = new Set(); c.ai.ammo = { ssm: 500, asm: 500 };
  for (let i = 0; i < 40; i++) { c.ai.cd = 0; seen.add(Sim.aiFireStep(c, ship, ms, 1).w); }
  assert.deepEqual([...seen].sort(), ["asm", "ssm"], "both weapons used inside SSM range");
  c.y = 100; c.ai.cd = 0; assert.equal(Sim.aiFireStep(c, ship, ms, 1).w, "asm", "only ASM reaches 100 nm");
  c.y = 200; c.ai.cd = 0; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "out of ASM range");
});
test("enemy ESM hears our jamming even with radar off; EMCON refuses and forces jamming off", () => {
  const ship = Sim.newShip(), c = mk(0, 20, { side: "enemy", emit: { name: "X", range: 35 } }); c.ai = Sim.newAi(5, null);
  run(dt => Sim.aiStep(c, ship, false, dt), 120); assert.equal(c.ai.hears, null, "radar off, jamming off: silent");
  ship.def.ecm = true; run(dt => Sim.aiStep(c, ship, false, dt), 60); assert.ok(c.ai.nHear > 0, "jamming is heard");
  assert.equal(Sim.toggleEcm(ship, true), "EMCON active: jamming unavailable."); assert.equal(ship.def.ecm, false);
  assert.ok(/ON/.test(Sim.toggleEcm(ship, false)) && ship.def.ecm, "can turn on without EMCON");
});
test("enemy radar equals ours: same range and same RCS for our ship", () => {
  const A = Sim.CFG.AI; assert.equal(A.SHIP_RCS, Sim.CFG.RADAR.RCS_REF); assert.equal(A.SWEEP, Sim.CFG.RADAR.PERIOD);
  const near = Sim.newShip(), c1 = mk(0, 25, { side: "enemy", emit: { name: "X", range: Sim.CFG.RADAR.RANGE } }), c2 = mk(0, 40, { side: "enemy", emit: { name: "X", range: Sim.CFG.RADAR.RANGE } });
  c1.ai = Sim.newAi(7, null); c2.ai = Sim.newAi(7, null);
  run(dt => { Sim.aiStep(c1, near, true, dt); Sim.aiStep(c2, near, true, dt); }, 120);
  assert.ok(c1.ai.dist !== undefined, "25 nm detected"); assert.equal(c2.ai.dist, undefined, "40 nm (beyond the 32 nm cap) never detected");
});

test("our radar: sees a normal contact at 30 nm (inside the cap), a small one (rcs 10) not", () => {
  const ship = Sim.newShip(), radar = Sim.newRadar(11), big = mk(0, 30), small = Sim.newContact(2, 90, 30, { rcs: 10 });
  run(dt => Sim.radarStep(radar, ship, [big, small], dt), 80);
  assert.ok(big.tracked, "30 nm tracked"); assert.equal(small.seen, false, "rcs 10 at 30 nm never seen");
});

const mkAi = (range, emitRange) => { const c = mk(0, range, { side: "enemy", speed: 15, emit: { name: "X", range: emitRange || 70 } }); c.ai = Sim.newAi(3, null); return c; };
test("AI identifies us (needs a continuous track), then engages when we are hostile and keeps radar on", () => {
  const ship = Sim.newShip(), c = mkAi(25); let sawId = false;
  run(dt => { Sim.aiStep(c, ship, true, dt); if (c.ai.state === "id") sawId = true; }, 300);
  assert.ok(sawId, "went through the id state"); assert.equal(c.ai.known, "host"); assert.equal(c.ai.state, "engage");
});
test("AI identifies a neutral and goes back to patrol; does not re-identify it", () => {
  const ship = Sim.newShip(); ship.rel = "neutral"; const c = mkAi(25);
  run(dt => Sim.aiStep(c, ship, true, dt), 300);
  assert.equal(c.ai.known, "neutral"); assert.equal(c.ai.state, "patrol");
  run(dt => Sim.aiStep(c, ship, true, dt), 60); assert.equal(c.ai.state, "patrol", "stays on patrol");
});
test("AI identify progress resets when the track is lost; gives up after GIVE_UP s without a track", () => {
  const ship = Sim.newShip(), c = mkAi(50); c.ai.state = "id"; c.ai.tracks = true; c.ai.q = 0.9; c.ai.idp = 0.6;
  Sim.aiStep(c, ship, true, 0.1); assert.ok(c.ai.idp > 0.6);
  c.ai.tracks = false; c.ai.q = 0; ship.x = 9999; Sim.aiStep(c, ship, true, 0.1); assert.equal(c.ai.idp, 0, "reset");
  run(dt => Sim.aiStep(c, ship, true, dt), Sim.CFG.AI.GIVE_UP + 5); assert.equal(c.ai.state, "patrol");
});
test("hunting AI closes at flank when far, opens range when too close, circles inside the band", () => {
  const A = Sim.CFG.AI, hold = A.HOLD * 70;
  const far = mkAi(150); far.hdg = 180; far.ai.state = "engage"; far.ai.tracks = true; far.ai.lx = 0; far.ai.ly = 0; far.ai.q = 0.9;
  run(dt => Sim.stepContact(far, dt), 900, 1); assert.ok(Math.hypot(far.x, far.y) < 150 - 5, "closed range"); assert.equal(far.spd, Sim.CFG.FLANK);
  const near = mkAi(20); near.hdg = 180; near.ai.state = "engage"; near.ai.tracks = true; near.ai.lx = 0; near.ai.ly = 0;
  run(dt => Sim.stepContact(near, dt), 3600, 1); assert.ok(Math.hypot(near.x, near.y) > 30, "opened range from 20 nm");
  const mid = mkAi(hold); mid.ai.state = "id"; mid.ai.tracks = true; Sim.stepContact(mid, 1); assert.equal(mid.spd, Sim.CFG.CRUISE, "cruise in the band");
});

test("AI radar: always 20/60 duty, except ON while identifying a held track; back to duty after identification", () => {
  const ship = Sim.newShip(), c = mkAi(50); const A = Sim.CFG.AI;
  c.ai.state = "id"; c.ai.tracks = true; c.ai.q = 0.9; c.ai.t = A.DUTY_ON + 5; // duty window is OFF here
  Sim.aiStep(c, ship, true, 0.1); assert.equal(c.emitting, true, "identifying with a track: radar on despite duty off");
  c.ai.tracks = false; c.ai.q = 0; ship.x = 9999; Sim.aiStep(c, ship, true, 0.1); assert.equal(c.emitting, (c.ai.t % A.DUTY_PERIOD) < A.DUTY_ON, "contact lost: duty cycle");
  const e = mkAi(50); e.ai.state = "engage"; e.ai.known = "host"; e.ai.tracks = true; e.ai.q = 0.9; e.ai.t = A.DUTY_ON + 5;
  Sim.aiStep(e, Sim.newShip(), true, 0.1); assert.equal(e.emitting, false, "engage: duty cycle applies");
  e.ai.t = 10; Sim.aiStep(e, Sim.newShip(), true, 0.1); assert.equal(e.emitting, true, "engage: on in the duty window");
});

// ---- enemy damage, defenses, retaliation ----
const mkEn = (range, o) => { const c = mkAi(range, 70); Sim.initEnemy(c, 11); return c; };
const own = (c, w, x, y, o) => Object.assign({ uid: 900 + Math.floor(Math.abs(x * 7 + y)), n: 1, side: "own", w, tid: c.id, x, y, hdg: 0, spd: 480, fuel: 100 }, o);
test("SAM ammo doubled (16) for player and enemy", () => {
  assert.equal(Sim.newShip().def.sam, 16); assert.equal(mkEn(50).def.sam, 16);
});
test("our missile at the last known position hits the enemy (stations lost) or misses if it is not there", () => {
  const s = Sim.newShip(), c = mkEn(30); c.px = c.x; c.py = c.y; Sim.CFG.DAMAGE.P_HIT = 1; // always hit when it connects
  const m = own(c, "asm", c.x, c.y - 0.2), ms = [m]; Sim.stepMissiles(ms, [c], 0.1, s);
  assert.equal(ms.length, 0); assert.ok(/HIT/.test(s.strikeMsg) && c.dead.some(Boolean), s.strikeMsg);
  const c2 = mkEn(30); c2.px = c2.x + 20; c2.py = c2.y; const ms2 = [own(c2, "ssm", c2.px, c2.py - 0.1)]; Sim.stepMissiles(ms2, [c2], 0.1, s);
  assert.ok(/MISSED/.test(s.strikeMsg) && !c2.dead.some(Boolean), "target 20 nm from the aim point: miss"); Sim.CFG.DAMAGE.P_HIT = 0.9;
});
test("enemy stations: sensors dead = radar/ESM off; weapons dead = no fire; destroyed = drifts to a wreck", () => {
  const ship = Sim.newShip(), c = mkEn(20), ms = []; c.ai.state = "engage"; c.ai.tracks = true; c.ai.q = 0.9;
  c.dead[2] = true; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null); c.dead[2] = false;
  c.dead[1] = true; run(dt => Sim.aiStep(c, ship, true, dt), 10); assert.equal(c.emitting, false); assert.equal(c.ai.tracks, false);
  c.dead = [true, true, true, true]; c.sunk = true; c.spd = 15; run(dt => Sim.stepContact(c, dt), 20); assert.equal(c.spd, 0); assert.ok(c.wreck);
  assert.equal(Sim.fireCheck(Sim.newShip(), 0, Object.assign(c, { tracked: true })), "Target destroyed.");
});
test("launching at an unknown enemy makes it hostile and engage", () => {
  const { s, c } = tracked(0, 10, { side: "enemy", speed: 0 }); c.ai = Sim.newAi(3, null); Sim.initEnemy(c, 5); assert.equal(c.ai.state, "patrol");
  Sim.startFire(s, 0, c); run(dt => Sim.fireStep(s, [c], [], dt), 6);
  assert.equal(c.ai.known, "host"); assert.equal(c.ai.state, "engage");
});
test("enemy defenses: SAM at ASM after the reaction delay; decoy/ECM/CIWS only on SSM; ASM ignores soft-kill", () => {
  const c = mkEn(0), cfg = Sim.CFG;
  const asm = own(c, "asm", 0, 10, { uid: 1 }), ms = [asm]; run(dt => Sim.aiDefStep(c, ms, dt), 1); assert.equal(c.def.sam, 16, "still reacting");
  run(dt => Sim.aiDefStep(c, ms, dt), 6); assert.equal(c.def.sam, 15); assert.equal(c.def.sams.length, 1); assert.equal(c.def.decoy, 4, "no decoy vs ASM");
  const c2 = mkEn(0), ssm = own(c2, "ssm", 0, 3.5, { uid: 2 }), m2 = [ssm];
  run(dt => Sim.aiDefStep(c2, m2, dt), 7); assert.equal(c2.def.sam, 15, "SSM also gets a SAM"); assert.equal(c2.def.decoy, 3, "decoy deployed vs SSM inside 4 nm"); assert.equal(c2.ecm, true);
  const c5 = mkEn(0), s5 = own(c5, "ssm", 0, 8, { uid: 5, aiT: 0 }); c5.def.sam = 0; run(dt => Sim.aiDefStep(c5, [s5], dt), 2); assert.equal(c5.def.decoy, 4, "no decoy beyond 4 nm");
  const c3 = mkEn(0), a3 = own(c3, "asm", 0, 0.5, { uid: 3, aiT: 0 }); c3.def.sam = 0; run(dt => Sim.aiDefStep(c3, [a3], dt), 200); assert.ok(!a3.state, "ASM: no decoy/ECM/CIWS effect");
  const c4 = mkEn(0), s4 = own(c4, "ssm", 0, 0.5, { uid: 4, aiT: 0 }); c4.def.sam = 0; c4.def.decoy = 0; run(dt => Sim.aiDefStep(c4, [s4], dt), 200); assert.ok(s4.state, "SSM at 0.5 nm: CIWS/ECM get it");
  // SAM flight resolves the kill
  Sim.CFG.DEFENSE.SAM.P = 1; run(dt => Sim.aiSamMove(c, ms, dt), 30); assert.equal(asm.state, "dead"); Sim.CFG.DEFENSE.SAM.P = 0.5;
});

test("horizon cap: radar and ESM detect nothing beyond it (radar 32 nm, ESM x1.3); both work inside", () => {
  const H = Sim.CFG.RADAR.HORIZON, big = { rcs: 1e9, emit: { range: 500 }, emitting: true };
  assert.equal(Sim.pDetect(H + 1, big), 0); assert.ok(Sim.pDetect(H - 5, { rcs: 10000 }) > 0.95);
  assert.equal(Sim.pEsm(H * Sim.CFG.ESM.DUCT + 1, big), 0); assert.ok(Sim.pEsm(H + 5, big) > 0.99);
  const ship = Sim.newShip(), c = mkAi(H + 5, 500); c.ai.state = "patrol"; c.ai.t = 0; run(dt => Sim.aiStep(c, ship, true, dt), 16); assert.equal(c.ai.tracks, false, "enemy radar also capped");
  c.y = H - 5; c.ai.t = 0; run(dt => Sim.aiStep(c, ship, true, dt), 12); assert.ok(c.ai.tracks);
});

test("decoys only seduce missiles within 4 nm (player)", () => {
  const s = Sim.newShip(), D = Sim.CFG.DEFENSE.DECOY; D.P = 1;
  const far = { uid: 1, side: "enemy", w: "ssm", tid: "own", x: 0, y: 10, hdg: 180, spd: 480, fuel: 99 }, near = { uid: 2, side: "enemy", w: "ssm", tid: "own", x: 0, y: 3, hdg: 180, spd: 480, fuel: 99 };
  Sim.deployDecoy(s, [far]); assert.ok(!far.state, "10 nm: not seduced"); s.def.cd = 0; assert.ok(/no missile within 4/.test(Sim.deployDecoy(s, [far])));
  s.def.cd = 0; Sim.deployDecoy(s, [far, near]); assert.equal(near.state, "decoy"); assert.ok(!far.state); D.P = 0.2;
});
test("AI ESM investigation: hears us without a track -> heads along the bearing; radar track -> identify; EMCON -> gives up after INV_HOLD", () => {
  const ship = Sim.newShip(), A = Sim.CFG.AI; ship.y = 40; // we are due north at 40 nm, our radar on (heard), enemy radar cannot see that far (cap 32)
  const c = mkAi(0, 70); c.hdg = 90; c.ai.wp = null;
  run(dt => Sim.aiStep(c, ship, true, dt), 20); assert.equal(c.ai.state, "inv", "ESM contact starts an investigation"); assert.equal(c.ai.tracks, false);
  assert.ok(Math.abs(Sim.diff(c.ai.hb, 0)) < 40, "bearing roughly north");
  run(dt => { Sim.aiStep(c, ship, true, dt); Sim.stepContact(c, dt); }, 600); assert.ok(c.y > 3, "moved north along the bearing"); assert.equal(c.spd, Sim.CFG.FLANK);
  // inside radar range the track starts identification
  ship.x = c.x; ship.y = c.y + 20; run(dt => Sim.aiStep(c, ship, true, dt), 70); assert.ok(["id", "engage"].includes(c.ai.state), c.ai.state);
  // EMCON: no more ESM, after INV_HOLD back to patrol
  const d = mkAi(0, 70); d.ai.state = "inv"; d.ai.hb = 0; d.ai.il = 0; ship.x = 0; ship.y = 300; run(dt => Sim.aiStep(d, ship, false, dt), A.INV_HOLD + 5); assert.equal(d.ai.state, "patrol");
  // neutral known: ignores ESM
  const e = mkAi(0, 70); e.ai.known = "neutral"; ship.y = 40; run(dt => Sim.aiStep(e, ship, true, dt), 30); assert.equal(e.ai.state, "patrol");
});

// ---- LINK, ally, ESM fixes ----
test("SAM 50% with 20 s reload, ECM 6%/s, ASM seeker 10 nm", () => { const C = Sim.CFG; assert.equal(C.DEFENSE.SAM.P, 0.5); assert.equal(C.DEFENSE.SAM.RELOAD, 20); assert.equal(C.DEFENSE.ECM.P, 0.06); assert.equal(C.WEAPONS.asm.seeker, 10); assert.equal(C.WEAPONS.ssm.seeker, 5); });
test("rays: crossing point, rejects parallel / behind / too far", () => {
  const p = Sim.rays(0, 0, 45, 10, 0, 315); assert.ok(Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y - 5) < 1e-6);
  assert.equal(Sim.rays(0, 0, 0, 5, 0, 0), null, "parallel"); assert.equal(Sim.rays(0, 0, 45, 10, 0, 135), null, "crossing behind");
  assert.equal(Sim.rays(0, 0, 1, 5, 0, 359), null, "beyond MAXR (or near parallel)");
});
test("esmStep stores the ally's bearing under its own key and does not take an ESM number", () => {
  const al = Sim.newAlly(5, 0), esmA = Sim.newEsm(9), c = mk(0, 20, { emit: { name: "X", range: 35 } });
  run(dt => Sim.esmStep(esmA, al, [c], dt, "esmA"), 10); assert.ok(c.esmA); assert.equal(c.esm, null); assert.ok(!c.esmNo);
});
test("LINK toggles, refuses under EMCON / destroyed sensors, and is heard by enemy ESM", () => {
  const ship = Sim.newShip(); assert.ok(!ship.link); Sim.toggleLink(ship, false); assert.equal(ship.link, true);
  assert.ok(/EMCON/.test(Sim.toggleLink(ship, true))); assert.equal(ship.link, false);
  ship.dead[1] = true; assert.ok(/Sensors/.test(Sim.toggleLink(ship, false)));
  const s2 = Sim.newShip(), c = mkAi(20, 70); Sim.toggleLink(s2, false); run(dt => Sim.aiStep(c, s2, false, dt), 20); assert.ok(c.ai.hears, "radar off, LINK on: heard");
});
test("ally holds its slot abeam, follows our course and speed", () => {
  const ship = Sim.newShip(), al = Sim.newAlly(0, 0); ship.spd = 15; ship.hdg = 0;
  run(dt => { ship.y += ship.spd * dt / 3600; Sim.allyStep(al, ship, dt); }, 5000);
  assert.ok(Math.abs(al.x - Sim.CFG.ALLY.OFFSET) < 0.5 && Math.abs(al.y - ship.y) < 0.5, al.x + "," + (al.y - ship.y)); assert.ok(Math.abs(al.spd - 15) < 3);
});
test("fix marker: both ESM lines fresh and crossing -> marker for 5 s, then gone", () => {
  const ship = Sim.newShip(), al = Sim.newAlly(5, 0), esm = Sim.newEsm(1), esmA = Sim.newEsm(2), c = mk(0, 40, { emit: { name: "X", range: 35 } }), fixes = [];
  esm.t = 10; esmA.t = 10; c.esmNo = 1; c.esm = { brg: 0, t: 10 }; c.esmA = { brg: Sim.norm(Math.atan2(-5, 40) * 180 / Math.PI), t: 10 };
  Sim.fixStep(fixes, ship, al, [c], esm, esmA, 0.1); assert.equal(fixes.length, 1); assert.ok(Math.abs(fixes[0].px) < 0.1 && Math.abs(fixes[0].py - 40) < 0.1); assert.ok(fixes[0].marker && fixes[0].tracked);
  esm.t = 20; esmA.t = 20; run(dt => Sim.fixStep(fixes, ship, al, [c], esm, esmA, dt), 4); assert.equal(fixes.length, 1, "still alive after 4 s");
  run(dt => Sim.fixStep(fixes, ship, al, [c], esm, esmA, dt), 2); assert.equal(fixes.length, 0, "gone after 5 s without fresh lines");
});
test("firing at a fix: missile flies to the fixed point and hits only a ship within the seeker radius", () => {
  const s = Sim.newShip(), c = mkEn(30); Sim.CFG.DAMAGE.P_HIT = 1; const fx = { id: "F1", marker: true, tracked: true, seen: true, px: c.x, py: c.y, x: c.x, y: c.y };
  s.fire = { slot: 0, tid: "F1", t: 0.05 }; const ms = []; Sim.fireStep(s, [fx], ms, 0.1); assert.equal(ms.length, 1); assert.equal(ms[0].tid, "mk"); assert.equal(ms[0].tx, c.x);
  ms[0].x = c.x; ms[0].y = c.y - 0.2; Sim.stepMissiles(ms, [c], 0.1, s); assert.ok(/FIX HIT/.test(s.strikeMsg), s.strikeMsg); assert.ok(c.dead.some(Boolean));
  const c2 = mkEn(30), m2 = [own(c2, "ssm", c2.x + 12, c2.y, { tid: "mk", tx: c2.x + 12, ty: c2.y })]; Sim.stepMissiles(m2, [c2], 0.1, s); assert.ok(/FIX MISSED/.test(s.strikeMsg)); Sim.CFG.DAMAGE.P_HIT = 0.9;
});
test("AI: linked enemies cross ESM bearings on us -> shared fix; fires at it when hostile known; missile acquires us only near the fix", () => {
  const ship = Sim.newShip(); ship.y = 30; const a = mkAi(0, 70), b = mkAi(0, 70); a.id = 1; b.id = 2; b.x = 25; b.y = 0; b.ai = Sim.newAi(4, null);
  run(dt => { Sim.aiStep(a, ship, true, dt); Sim.aiStep(b, ship, true, dt); Sim.aiFixStep([a, b], dt); }, 20);
  assert.ok(a.ai.fix && b.ai.fix, "both hold a fix"); assert.ok(Math.hypot(a.ai.fix.x - 0, a.ai.fix.y - 30) < 80);
  assert.equal(Sim.aiFireStep(a, ship, [], 1), null, "does not know it is hostile: no shot"); a.ai.known = "host"; a.ai.fix = { x: 3, y: 38, t: 5, host: true }; a.ai.state = "patrol";
  const ms = []; const m = Sim.aiFireStep(a, ship, ms, 1); assert.ok(m && m.tx === 3 && m.ty === 38, "fired at the fix");
  const lost = { uid: 2, side: "enemy", w: "ssm", tid: "own", x: 0, y: 19.9, hdg: 0, spd: 480, fuel: 99, tx: 0, ty: 20 }; ship.y = 100; const l = [lost]; Sim.stepMissiles(l, [], 0.1, ship); assert.equal(l.length, 0, "reached the fix, no ship near: lost"); assert.ok(/MISSED/.test(ship.hitMsg));
  const hit = { uid: 3, side: "enemy", w: "ssm", tid: "own", x: 0, y: 36, hdg: 0, spd: 480, fuel: 99, tx: 0, ty: 20 }; ship.y = 40; Sim.stepMissiles([hit], [], 0.1, ship); assert.equal(hit.tx, undefined, "ship within 5 nm: seeker acquired it");
});

test("fire at a FIX marker still launches after the marker expired (point kept)", () => {
  const s = Sim.newShip(), c = mkEn(30), fx = { id: "F1", marker: true, tracked: true, seen: true, px: c.x, py: c.y };
  assert.ok(Sim.startFire(s, 0, fx)); const ms = []; Sim.fireStep(s, [], ms, 6); // marker gone from the list
  assert.equal(ms.length, 1); assert.equal(ms[0].tid, "mk");
});

test("destroyed contact is dropped from tracking by the radar", () => {
  const { s, c } = tracked(0, 10); assert.ok(c.tracked); c.sunk = true;
  const r = Sim.newRadar(1); run(dt => Sim.radarStep(r, s, [c], dt), 10);
  assert.equal(c.tracked, false); assert.equal(c.q, 0);
});

// ---- ally is hittable ----
test("enemy missile at the ally hits it with the same station rules; sunk ally drifts to a wreck", () => {
  const P = Sim.CFG.DAMAGE.P_HIT; Sim.CFG.DAMAGE.P_HIT = 1;
  const s = Sim.newShip(), al = Sim.newAlly(15, 0), ms = [{ uid: 1, n: 1, lbl: "H1", side: "enemy", w: "asm", tid: "A1", x: 15, y: 0.1, hdg: 0, spd: 500, fuel: 50 }];
  Sim.stepMissiles(ms, [], 0.1, s, al); Sim.CFG.DAMAGE.P_HIT = P;
  assert.equal(ms.length, 0); assert.ok(al.dead.some(Boolean), "a station lost"); assert.ok(/H1 > A1 HIT/.test(s.hitMsg));
  Sim.CFG.DAMAGE.P_HIT = 1; const ms2 = [{ uid: 2, n: 2, side: "enemy", w: "asm", tid: "A1", x: 15, y: 0.1, hdg: 0, spd: 500, fuel: 50 }];
  for (let i = 0; i < 6 && !al.sunk; i++) { ms2.push({ uid: 3 + i, n: 3, side: "enemy", w: "asm", tid: "A1", x: 15, y: 0.1, hdg: 0, spd: 500, fuel: 50 }); Sim.stepMissiles(ms2, [], 0.1, s, al); }
  Sim.CFG.DAMAGE.P_HIT = P; assert.ok(al.sunk, "ally destroyed");
  al.spd = 15; run(dt => Sim.allyStep(al, s, dt), 30); assert.ok(al.wreck && al.spd === 0);
  const x = al.x; run(dt => Sim.allyStep(al, s, dt), 10); assert.equal(al.x, x, "wreck does not follow");
});
test("enemy tracks the ally with its radar and fires at it when engaged; not at a destroyed ally", () => {
  const s = Sim.newShip(), al = Sim.newAlly(0, 30), c = mkEn(60); c.x = 0; c.y = 0; s.x = 0; s.y = -90; // we are far out of reach, the ally is 30 nm away
  c.ai.state = "engage"; c.ai.known = "host"; c.ai.t = 0;
  run(dt => { Sim.aiStep(c, s, true, dt, al); }, 30); assert.ok(c.ai.fr.A1 && c.ai.fr.A1.tracks && c.ai.fr.A1.q > Sim.CFG.AI.FIRE_Q, "solid track on the ally");
  const m = Sim.aiFireStep(c, s, [], 0, al); assert.ok(m && m.tid === "A1" && m.side === "enemy", "fires at the ally");
  al.sunk = true; c.ai.cd = 0; run(dt => Sim.aiStep(c, s, true, dt, al), 5); assert.ok(!c.ai.fr.A1); assert.equal(Sim.aiFireStep(c, s, [], 0, al), null);
});

// ---- ally defends itself ----
test("ally SAMs an ASM aimed at it, decoys an SSM only inside range; destroyed DEFENSE disables it", () => {
  const S = Sim.CFG.DEFENSE, P = S.SAM.P; S.SAM.P = 1;
  const al = Sim.newAlly(0, 0), s = Sim.newShip();
  const ms = [{ uid: 1, n: 1, side: "enemy", w: "asm", tid: "A1", x: 0, y: 20, hdg: 180, spd: 500, fuel: 100 }];
  run(dt => { Sim.allyDefStep(al, ms, dt); Sim.allySamMove(al, ms, dt); }, 60, 0.1);
  S.SAM.P = P; assert.equal(al.def.sam, S.SAM.AMMO - 1, "one SAM used"); assert.equal(ms[0].state, "dead");
  const al2 = Sim.newAlly(0, 0), m2 = [{ uid: 2, n: 2, side: "enemy", w: "ssm", tid: "A1", x: 0, y: 3, hdg: 180, spd: 480, fuel: 100 }];
  Sim.allyDefStep(al2, m2, 0.1); assert.equal(al2.def.decoy, S.DECOY.AMMO, "no decoy beyond 4 nm");
  const al3 = Sim.newAlly(0, 0); al3.dead[3] = true; const m3 = [{ uid: 3, n: 3, side: "enemy", w: "asm", tid: "A1", x: 0, y: 20, hdg: 180, spd: 500, fuel: 100 }];
  run(dt => Sim.allyDefStep(al3, m3, dt), 10, 0.1); assert.equal(al3.def.sam, S.SAM.AMMO, "dead DEFENSE: no SAM");
});

// ---- team-agnostic AI: the ally runs the same AI against the enemy team ----
test("ally AI tracks an enemy, identifies it, fires, and the missile damages it", () => {
  const s = Sim.newShip(), al = Sim.newAlly(0, 0), c = mkEn(30); c.x = 0; c.y = 30; c.ai.t = 0; al.ai.t = 0; s.x = 0; s.y = -90;
  const ms = [], P = Sim.CFG.WEAPON; let fired = null;
  run(dt => { Sim.aiStep(al, s, true, dt, al, [c]); fired = fired || Sim.aiFireStep(al, s, ms, dt, al, [c]); }, 200);
  assert.equal(al.ai.known, "host", "ally identified the enemy as hostile"); assert.ok(fired, "ally fired");
  assert.equal(fired.side, "ally"); assert.equal(fired.tid, c.id); assert.ok(/^A\d/.test(fired.lbl));
  const sp = Sim.CFG.DAMAGE.P_HIT; Sim.CFG.DAMAGE.P_HIT = 1; c.rng.seed = 5;
  run(dt => Sim.stepMissiles(ms, [c], dt, s, al), 600, 1); Sim.CFG.DAMAGE.P_HIT = sp;
  assert.ok(c.dead.some(Boolean), "enemy lost a station"); assert.ok(/> TRK/.test(s.strikeMsg), s.strikeMsg);
});
test("enemy defenses engage the ally's missiles; enemy ESM hears the ally's radar; no friendly fire", () => {
  const al = Sim.newAlly(0, 0), c = mkEn(20), s = Sim.newShip(); c.x = 0; c.y = 20; c.ai.t = 0;
  const m = { uid: 9, n: 1, lbl: "A1", side: "ally", w: "asm", tid: c.id, x: 0, y: 5, hdg: 0, spd: 500, fuel: 100 }, SP = Sim.CFG.DEFENSE.SAM.P; Sim.CFG.DEFENSE.SAM.P = 1;
  run(dt => { Sim.aiDefStep(c, [m], dt); Sim.aiSamMove(c, [m], dt); }, 90, 0.1); Sim.CFG.DEFENSE.SAM.P = SP;
  assert.equal(m.state, "dead", "enemy SAM kills the ally's ASM");
  al.ai.t = 0; run(dt => { Sim.aiStep(al, s, false, dt, al, [c]); Sim.aiStep(c, s, false, dt, al, [c]); }, 120); // ship radar silent: only the ally emits
  assert.ok(c.ai.nHear > 0, "enemy hears the ally's radar");
  const f = Sim.aiFireStep(al, s, [], 1, al, []); assert.equal(f, null, "no foes: nothing to fire at");
});

test("ally escorts, then hunts a hostile it is identifying/engaging, and returns to its slot after giving up", () => {
  const s = Sim.newShip(), al = Sim.newAlly(15, 0), H = Sim.CFG.AI;
  run(dt => Sim.allyStep(al, s, dt), 60); const y0 = al.y; assert.ok(Math.abs(al.x - 15) < 1 && Math.abs(y0) < 1, "holds the slot");
  al.ai.state = "engage"; al.ai.tracks = true; al.ai.lx = 15; al.ai.ly = 80; al.ai.q = 0.9; al.emit.range = 70;
  run(dt => Sim.allyStep(al, s, dt), 600, 1); assert.ok(al.y > 4, "left the slot toward the hostile"); assert.equal(al.spd, Sim.CFG.FLANK);
  al.ai.state = "patrol"; al.ai.tracks = false; run(dt => Sim.allyStep(al, s, dt), 3000, 1); assert.ok(Math.hypot(al.x - 15, al.y) < 1, "back in the slot");
  const d = Sim.newAlly(15, 0); d.dead[0] = true; d.hdg = 90; d.spd = 10; d.ai.state = "engage"; d.ai.tracks = true; d.ai.lx = 0; d.ai.ly = 80; Sim.allyStep(d, s, 1); assert.equal(d.hdg, 90, "NAV destroyed holds course");
});

test("ally AI switches to the enemy it actually tracks (primary foe out of reach) and engages it", () => {
  const s = Sim.newShip(), al = Sim.newAlly(0, 0), far = mkEn(60), near = mkEn(25); far.id = 1; near.id = 2; far.x = 0; far.y = 60; near.x = 20; near.y = 15; s.x = 0; s.y = -90; al.ai.t = 0;
  const ms = []; let fired = null;
  run(dt => { Sim.aiStep(al, s, true, dt, al, [far, near]); fired = fired || Sim.aiFireStep(al, s, ms, dt, al, [far, near]); }, 200);
  assert.equal(al.ai.pid, 2, "primary follows the tracked enemy"); assert.equal(al.ai.known, "host"); assert.ok(fired && fired.tid === 2 && fired.side === "ally", "fired at the near enemy");
});

test("player SAM reload: second launch refused for 20 s", () => {
  const ship = Sim.newShip(), ms = [{ uid: 1, n: 1, side: "enemy", w: "ssm", tid: "own", x: 0, y: 10, hdg: 180, spd: 480, fuel: 100 }, { uid: 2, n: 2, side: "enemy", w: "ssm", tid: "own", x: 0, y: 12, hdg: 180, spd: 480, fuel: 100 }];
  assert.equal(Sim.launchSam(ship, ms, 1), "SAM launched.");
  assert.match(Sim.launchSam(ship, ms, 2), /reloading/);
  Sim.ciwsStep(ship, [], 20); assert.equal(Sim.launchSam(ship, ms, 2), "SAM launched.");
});

test("stepUnit: one movement entry point for human ship, ally and enemy", () => {
  const s = Sim.newShip(); s.ordSpd = 15; s.ordHdg = 90; run(dt => Sim.stepUnit(s, dt), 60, 1); assert.ok(s.spd > 14 && s.x > 0.1, "human unit follows its orders");
  const al = Sim.newAlly(15, 0); assert.ok(al.escort && al.ctl === "ai"); s.ordSpd = 0; s.spd = 0; s.x = 0; s.y = 0; s.hdg = 0;
  run(dt => Sim.stepUnit(al, dt, s), 60, 1); assert.ok(Math.abs(al.x - 15) < 1, "escort holds its slot");
  const c = Sim.newContact(1, 0, 20, {}); Sim.initEnemy(c, 1); c.ai = Sim.newAi(5, [[0, 30], [10, 30]]); c.hdg = 0; c.spd = 15; run(dt => Sim.stepUnit(c, dt), 120, 1); assert.ok(c.y > 20.3, "AI unit patrols its waypoints");
  c.sunk = true; run(dt => Sim.stepUnit(c, dt), 30, 1); assert.ok(c.wreck && c.spd === 0, "sunk unit drifts to a wreck");
});
