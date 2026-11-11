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
