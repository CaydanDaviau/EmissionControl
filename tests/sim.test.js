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
