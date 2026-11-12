const test = require("node:test"), assert = require("node:assert/strict"), Sim = require("../sim.js");
const run = (fn, secs, dt = 0.1) => { for (let i = 0; i < secs / dt; i++) fn(dt); };
const mk = (b, r, o) => Sim.newContact(1, b, r, o);

test("ESM hears an emitter beyond radar horizon, within duct cap; not beyond cap", () => {
  const ship = Sim.newShip(), esm = Sim.newEsm(1);
  const near = mk(0, 26, { emit: { name: "X", range: 35 } }), far = mk(90, 35, { emit: { name: "X", range: 35 } });
  run(dt => Sim.esmStep(esm, ship, [near, far], dt), 60);
  assert.ok(near.esm, "26 nm heard"); assert.equal(far.esm, null, "35 nm beyond cap");
  assert.ok(Math.abs(Sim.diff(near.esm.brg, 0)) < 10);
});
test("silent emitter is not heard; esm expires after HOLD", () => {
  const ship = Sim.newShip(), esm = Sim.newEsm(2), c = mk(0, 20, { emit: { name: "X", range: 35 } });
  run(dt => Sim.esmStep(esm, ship, [c], dt), 30); assert.ok(c.esm);
  c.emitting = false; run(dt => Sim.esmStep(esm, ship, [c], dt), 20); assert.equal(c.esm, null);
});
test("radar sees at 20 nm only inside horizon; EMCON (radar.on=false) blinds and tracks fade", () => {
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

test("enemy AI: duty cycle, detects ship, ESM hears radar, patrols", () => {
  const S = require("../sim.js"); const ship = S.newShip();
  const c = S.newContact(1, 0, 21, { side: "enemy", speed: 15, emit: { name: "T", range: 35 } });
  c.ai = S.newAi(7, [[10, 23], [10, 35], [-10, 35], [-10, 23]]); c.hdg = 90;
  let on = 0, tot = 0, tracked = false, heard = false;
  for (let i = 0; i < 600; i++) { S.aiStep(c, ship, true, 1); S.stepContact(c, 1); tot++; if (c.emitting) on++; tracked = tracked || c.ai.tracks; heard = heard || !!c.ai.hears; }
  assert.ok(Math.abs(on / tot - 1 / 3) < 0.02); assert.ok(tracked); assert.ok(heard);
  const c2 = S.newContact(2, 0, 21, { emit: { name: "T", range: 35 } }); c2.ai = S.newAi(7, [[0, 21]]);
  for (let i = 0; i < 300; i++) S.aiStep(c2, ship, false, 1);
  assert.ok(!c2.ai.hears); // our radar off: not heard
});

test("AI fires only with a good track, one per cooldown, ASM beyond SSM range, SSM inside", () => {
  const ship = Sim.newShip(), ms = [], c = mk(0, 20, { side: "enemy" }); c.ai = Sim.newAi(1, null);
  assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "no track, no fire");
  c.ai.tracks = true; c.ai.q = 0.4; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "track too weak");
  c.ai.q = 0.8; const m1 = Sim.aiFireStep(c, ship, ms, 1);
  assert.ok(m1 && m1.w === "ssm" && m1.tid === "own" && m1.side === "enemy", "SSM inside 70 nm");
  assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "cooldown");
  run(dt => Sim.aiFireStep(c, ship, ms, dt), 0); c.ai.cd = 0; c.y = 100;
  const m2 = Sim.aiFireStep(c, ship, ms, 1); assert.ok(m2 && m2.w === "asm", "ASM beyond SSM range");
  c.ai.cd = 0; c.y = 200; assert.equal(Sim.aiFireStep(c, ship, ms, 1), null, "out of ASM range");
  assert.equal(ms.length, 2); assert.equal(c.ai.ammo.ssm, 7); assert.equal(c.ai.ammo.asm, 3);
});
