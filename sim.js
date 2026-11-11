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
    RADAR: { RANGE: 70, H_ANT: 100, PERIOD: 4, RCS_REF: 10000, Q_HIT: 0.35, Q_MISS: 0.08, Q_DROP: 0.10 }
  };
  const norm = a => ((a % 360) + 360) % 360;
  const diff = (to, from) => { const d = norm(to - from); return d > 180 ? d - 360 : d; };

  function newShip() { return { x: 0, y: 0, hdg: 0, spd: 0, ordHdg: 0, ordSpd: 0 }; } // x east nm, y north nm

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
  function newRadar(seed) { return { ang: 0, t: 0, seed: seed | 0 }; }
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
      cls: "unk", identified: false,           // cls = current tag; identified = permanent ID (later stage)
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
      if (rand(r) < pDetect(Math.hypot(dx, dy), c)) {
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
  function setTag(c, cls) { if (!c.tracked) return false; c.cls = cls; return true; }

  const api = { CFG, norm, diff, newShip, step, newRadar, newContact, pDetect, radarStep, setTag };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sim = api;
})(typeof self !== "undefined" ? self : this);
