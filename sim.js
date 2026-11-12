"use strict";
// Sim core (pure: no DOM, no Date, no Math.random). Used by the UI now; later by Worker/server.
(function (root) {
  const CFG = {
    FLANK: 30,     // kt, Arleigh Burke top speed (tunable)
    CRUISE: 15,    // kt, all surface ships (formation speed)
    REVERSE: -8,   // kt, astern (tunable)
    ACCEL: 0.5,    // kt per sim-second
    TURN: 3,       // deg per sim-second at full steering speed
    TURN_FULL_AT: 8, // kt at which turn rate is 100%
    TURN_MIN: 0.2, // fraction of turn rate left when slow/stopped
    // Burke radar (per-ship data later)
    RADAR: { RANGE: 70, H_ANT: 100, PERIOD: 4, RCS_REF: 10000, Q_HIT: 0.35, Q_MISS: 0.08, Q_DROP: 0.10 },
    // ESM (passive): hears emitting radars, bearing only. Own-ship data, per-ship later.
    // Detect range = RANGE_FACTOR * emitter radar range, capped by horizon * DUCT (ducting).
    ESM: { H_ANT: 100, RANGE_FACTOR: 2, DUCT: 1.3, INTERVAL: 2, SIGMA: 3, HOLD: 15 },
    // Identify: needs a continuous radar track (real time, like all sensors). Takes longer at long range and for low-RCS (stealthy) contacts. Track lost = reset to 0.
    // Weapons (game data; per-ship loadouts later). range nm, speed kt, turn deg/s
    WEAPONS: { ssm: { name: "SSM", model: "RGM-84", range: 70, speed: 480, turn: 10 },
      asm: { name: "ASM", model: "LRASM", range: 150, speed: 500, turn: 8 } },
    WEAPON: { COUNTDOWN: 5, ARRIVE: 0.5 }, // launch countdown (s, real time); arrive radius (nm)
    IDENTIFY: { TIME: 20, D_REF: 10, MIN: 5, MAX: 90 } // TIME = seconds at D_REF nm for a normal (RCS_REF) contact
  };
  const norm = a => ((a % 360) + 360) % 360;
  const diff = (to, from) => { const d = norm(to - from); return d > 180 ? d - 360 : d; };

  function newShip() { return { x: 0, y: 0, hdg: 0, spd: 0, ordHdg: 0, ordSpd: 0,
    loadout: [{ w: "ssm", ammo: 8 }, { w: "asm", ammo: 4 }], fire: null, fireMsg: "", nMsl: 0 }; } // x east nm, y north nm

  function step(s, dt) {
    const ds = s.ordSpd - s.spd, ma = CFG.ACCEL * dt;
    s.spd = Math.abs(ds) <= ma ? s.ordSpd : s.spd + Math.sign(ds) * ma;
    const f = Math.max(CFG.TURN_MIN, Math.min(1, Math.abs(s.spd) / CFG.TURN_FULL_AT));
    const dh = diff(s.ordHdg, s.hdg), mt = CFG.TURN * f * dt;
    s.hdg = norm(Math.abs(dh) <= mt ? s.ordHdg : s.hdg + Math.sign(dh) * mt);
    const r = s.hdg * Math.PI / 180, d = s.spd * dt / 3600;
    s.x += Math.sin(r) * d; s.y += Math.cos(r) * d;
  }

  // ---- radar ----
  function newRadar(seed) { return { ang: 0, t: 0, seed: seed | 0, on: true }; } // on=false: EMCON, beam turns but nothing is detected
  function rand(r) { // mulberry32, state in r.seed
    r.seed = (r.seed + 0x6D2B79F5) | 0;
    let t = Math.imul(r.seed ^ (r.seed >>> 15), 1 | r.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function newContact(id, bearing, range, o) {
    o = o || {};
    const a = bearing * Math.PI / 180;
    return { id, cat: "SRF", side: o.side || "unk", rcs: o.rcs || 10000, h: o.h || 60,
      x: Math.sin(a) * range, y: Math.cos(a) * range,
      hdg: o.course || 0, spd: o.speed || 0,                  // optional motion (kt)
      emit: o.emit || null, emitting: !!o.emit, esm: null, esmNo: 0, // emit = {name, range}; esm = last ESM bearing

      // side (hidden truth): "unk" = neutral/unknown, "ally", "enemy". cls = current tag; identified = permanent ID.
      cls: "unk", identified: false, idActive: false, idProg: 0, idNote: "", // idNote: "" | "lost" | "emcon" (interrupted)
      seen: false, tracked: false, q: 0, px: 0, py: 0, lastHit: -1e9 };
  }
  function pDetect(d, c) {
    const R = CFG.RADAR, hor = 1.23 * (Math.sqrt(R.H_ANT) + Math.sqrt(c.h));
    if (d > hor) return 0;
    const rd = R.RANGE * Math.pow(c.rcs / R.RCS_REF, 0.25);
    return 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd)));
  }
  function radarStep(r, ship, contacts, dt) {
    const inc = 360 / CFG.RADAR.PERIOD * dt, a0 = r.ang;
    r.ang = norm(a0 + inc); r.t += dt;
    for (const c of contacts) {
      const dx = c.x - ship.x, dy = c.y - ship.y;
      const b = norm(Math.atan2(dx, dy) * 180 / Math.PI), sd = norm(b - a0);
      if (sd <= 0 || sd > inc) continue;               // beam did not pass this contact
      if (r.on && rand(r) < pDetect(Math.hypot(dx, dy), c)) {
        const first = !c.tracked;
        c.q += (1 - c.q) * CFG.RADAR.Q_HIT; c.lastHit = r.t;
        c.px = c.x; c.py = c.y; c.seen = true;
        if (first) { c.tracked = true; if (!c.identified) c.cls = c.side === "ally" ? "ally" : "unk"; }
      } else if (c.tracked) {
        c.q -= CFG.RADAR.Q_MISS;
        if (c.q < CFG.RADAR.Q_DROP) { c.tracked = false; c.q = 0; if (!c.identified) c.cls = "unk"; }
      }
    }
  }
  function stepContact(c, dt) {
    if (!c.spd) return;
    const r = c.hdg * Math.PI / 180, d = c.spd * dt / 3600;
    c.x += Math.sin(r) * d; c.y += Math.cos(r) * d;
  }
  // ---- ESM ----
  function newEsm(seed) { return { t: 0, acc: 0, n: 0, seed: seed | 0 }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(Math.max(rand(r), 1e-12))) * Math.cos(2 * Math.PI * rand(r)); }
  function pEsm(d, c) {
    const E = CFG.ESM, hor = 1.23 * (Math.sqrt(E.H_ANT) + Math.sqrt(c.h)) * E.DUCT;
    if (!c.emit || !c.emitting || d > hor) return 0;
    const rd = E.RANGE_FACTOR * c.emit.range;
    return 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd)));
  }
  function esmStep(e, ship, contacts, dt) {
    const E = CFG.ESM; e.t += dt; e.acc += dt;
    while (e.acc >= E.INTERVAL) {
      e.acc -= E.INTERVAL;
      for (const c of contacts) {
        if (!c.emit) continue;
        const dx = c.x - ship.x, dy = c.y - ship.y;
        if (c.emitting && rand(e) < pEsm(Math.hypot(dx, dy), c)) {
          const b = norm(Math.atan2(dx, dy) * 180 / Math.PI + gauss(e) * E.SIGMA);
          if (!c.esmNo) c.esmNo = ++e.n;
          c.esm = { brg: c.esm ? norm(c.esm.brg + 0.4 * diff(b, c.esm.brg)) : b, t: e.t }; // light smoothing
        }
        if (c.esm && e.t - c.esm.t > E.HOLD) c.esm = null;
      }
    }
  }
  function setTag(c, cls) { if (!c.tracked || c.identified) return false; c.cls = cls; return true; } // identified = tag locked
  // ---- identify ----
  function startIdentify(c) {
    if (!c.tracked || c.identified || c.idActive) return false;
    c.idActive = true; c.idProg = 0; c.idNote = ""; return true;
  }
  function identifyTime(c, ship) { // seconds needed now: grows with range, and with low RCS (RCS_REF/rcs)^0.25
    const I = CFG.IDENTIFY, d = Math.hypot(c.x - ship.x, c.y - ship.y);
    const t = I.TIME * (0.6 + 0.4 * d / I.D_REF) * Math.pow(CFG.RADAR.RCS_REF / c.rcs, 0.25);
    return Math.max(I.MIN, Math.min(I.MAX, t));
  }
  function cancelIdentify(c) { c.idActive = false; c.idProg = 0; c.idNote = ""; }
  function identifyStep(contacts, dt, radarOn, ship) { // real-time dt, once per frame. Radar silent (EMCON) interrupts at once
    for (const c of contacts) {
      if (!c.idActive) continue;
      if (!radarOn) { c.idActive = false; c.idProg = 0; c.idNote = "emcon"; continue; }
      if (!c.tracked) { c.idActive = false; c.idProg = 0; c.idNote = "lost"; continue; } // track lost: interrupted, progress resets
      c.idProg += dt / identifyTime(c, ship); // idProg is a fraction 0..1
      if (c.idProg >= 1) {
        c.idActive = false; c.idProg = 0; c.identified = true; c.idNote = "";
        c.cls = c.side === "ally" ? "ally" : c.side === "enemy" ? "host" : "unk"; // reveals hidden truth, tag locked
      }
    }
  }

  // ---- weapons: select target + weapon, countdown, launch. A launched missile flies toward the target's last known position. ----
  function fireCheck(ship, slot, c) { // "" if OK, else the reason it can't fire
    if (slot == null) return "Select a weapon.";
    if (!c) return "Select a tracked contact.";
    if (!c.tracked) return "Target not tracked.";
    const L = ship.loadout[slot], W = CFG.WEAPONS[L.w];
    if (L.ammo <= 0) return "No ammo.";
    const d = Math.hypot(c.px - ship.x, c.py - ship.y);
    if (d > W.range) return "Out of range: " + d.toFixed(1) + " / " + W.range + " NM.";
    return "";
  }
  function startFire(ship, slot, c) {
    if (ship.fire || fireCheck(ship, slot, c)) return false;
    ship.fire = { slot, tid: c.id, t: CFG.WEAPON.COUNTDOWN }; ship.fireMsg = ""; return true;
  }
  function cancelFire(ship) { if (ship.fire) { ship.fire = null; ship.fireMsg = "Launch aborted."; } }
  function fireStep(ship, contacts, missiles, dt) { // real-time dt, once per frame
    const f = ship.fire; if (!f) return;
    const c = contacts.find(k => k.id === f.tid), why = fireCheck(ship, f.slot, c);
    if (why) { ship.fire = null; ship.fireMsg = "Launch aborted: " + why; return; } // track lost, out of range...
    f.t -= dt; if (f.t > 0) return;
    const L = ship.loadout[f.slot], W = CFG.WEAPONS[L.w];
    L.ammo--; ship.fire = null; ship.fireMsg = "";
    missiles.push({ n: ++ship.nMsl, w: L.w, tid: c.id, x: ship.x, y: ship.y, hdg: ship.hdg, spd: W.speed, fuel: W.range });
  }
  function stepMissiles(missiles, contacts, dt) { // scaled dt. Finished missiles are removed (no damage yet)
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i], c = contacts.find(k => k.id === m.tid), W = CFG.WEAPONS[m.w];
      const dx = c.px - m.x, dy = c.py - m.y;
      if (Math.hypot(dx, dy) < CFG.WEAPON.ARRIVE) { missiles.splice(i, 1); continue; }
      const want = norm(Math.atan2(dx, dy) * 180 / Math.PI), dh = diff(want, m.hdg), mt = W.turn * dt;
      m.hdg = norm(Math.abs(dh) <= mt ? want : m.hdg + Math.sign(dh) * mt); // turn-rate limited, so it curves on the scope
      const d = m.spd * dt / 3600, r = m.hdg * Math.PI / 180;
      m.x += Math.sin(r) * d; m.y += Math.cos(r) * d; m.fuel -= d;
      if (m.fuel <= 0) missiles.splice(i, 1); // out of fuel
    }
  }

  const api = { CFG, norm, diff, newShip, step, newRadar, newContact, pDetect, radarStep, setTag, stepContact, newEsm, pEsm, esmStep, startIdentify, cancelIdentify, identifyStep, identifyTime, fireCheck, startFire, cancelFire, fireStep, stepMissiles };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sim = api;
})(typeof self !== "undefined" ? self : this);
