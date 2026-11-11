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
    TURN_MIN: 0.2  // fraction of turn rate left when slow/stopped
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

  const api = { CFG, norm, diff, newShip, step };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sim = api;
})(typeof self !== "undefined" ? self : this);
