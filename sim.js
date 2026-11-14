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
    RADAR: { HORIZON: 32, RANGE: 70, H_ANT: 100, PERIOD: 4, RCS_REF: 10000, Q_HIT: 0.35, Q_MISS: 0.08, Q_DROP: 0.10 },
    // ESM (passive): hears emitting radars, bearing only. Own-ship data, per-ship later.
    // Detect range = RANGE_FACTOR * emitter radar range. No horizon cap for now (user's choice; H_ANT and DUCT are unused).
    ESM: { H_ANT: 100, RANGE_FACTOR: 2, DUCT: 1.3, INTERVAL: 2, SIGMA: 10, HOLD: 15 },
    // Identify: needs a continuous radar track (real time, like all sensors). Takes longer at long range and for low-RCS (stealthy) contacts. Track lost = reset to 0.
    // Weapons (game data; per-ship loadouts later). range nm, speed kt, turn deg/s
    WEAPONS: { ssm: { name: "SSM", model: "RGM-84", range: 70, speed: 480, turn: 10, dmg: "SSM", seeker: 5 },
      asm: { name: "ASM", model: "LRASM", range: 150, speed: 500, turn: 8, dmg: "ASM", seeker: 10 } },
    // Damage is per station (index 0..3 = NAVIGATION, SENSORS, WEAPONS, DEFENSE). second = chance a hit destroys a 2nd station; nav = can hit NAVIGATION.
    // Ship is destroyed when 1 or fewer stations are left. Destroyed ship decelerates by DRIFT_DECEL (kt/s), then stays as a wreck.
    DAMAGE: { P_HIT: 0.9, DRIFT_DECEL: 1, DEBUG_DIST: 20, SSM: { second: 0.15, nav: false }, ASM: { second: 0.55, nav: true } },
    // Defense (game data, tunable). Decoy: small chance per deploy to seduce each incoming missile (it then flies straight on, unguided). CIWS: fixed chance per second on ONE missile inside its range.
    // SAM: long range, highest kill chance, limited ammo; resolves after flight time. Dead missiles stay as a white X for X_TIME real seconds.
    DEFENSE: { ECM: { NAME: "AN/SLQ-32", RANGE: 20, P: 0.06, EMIT: 40 }, DECOY: { P: 0.2, AMMO: 4, CD: 20, RANGE: 4 }, CIWS: { RANGE: 1, P: 0.1 }, SAM: { RANGE: 25, P: 0.5, AMMO: 16, SPEED: 2000, RELOAD: 20 }, X_TIME: 10, STRAY: 60 },
    LINK: { EMIT: 25 }, FIX: { LIFE: 5, FRESH: 2.5, MIN_SIN: 0.05, MAXR: 120 }, ALLY: { OFFSET: 15 }, // LINK emits (enemy ESM hears it); FIX = marker where two ESM bearing lines cross: lives LIFE s, bearings count as fresh for FRESH s, lines must cross at > MIN_SIN and < MAXR nm; ALLY = formation slot nm abeam (starboard)
    WEAPON: { COUNTDOWN: 5, ARRIVE: 0.5, SEEKER: 5 }, // SEEKER = nm: a missile reaching the last known position hits only if the target is truly within this; // launch countdown (s, real time); arrive radius (nm)
    AI: { DUTY_PERIOD: 60, DUTY_ON: 20, SWEEP: 4, SHIP_RCS: 10000, SHIP_H: 60, H_ANT: 100, COAST: 0.02, TURN: 3, WP_NM: 1, FIRE_Q: 0.5, FIRE_CD: 30, FIX_CD: 180, HOLD: 0.8, BAND: 4, GIVE_UP: 180, REACT_MIN: 2, REACT_MAX: 5, INV_HOLD: 60 }, // HOLD = fraction of its radar range it tries to keep us at (detection edge), BAND = +- nm around that, GIVE_UP = real s without a track before it goes back to patrol; // enemy radar on 20 s of every 60 s; FIRE_Q = min track quality to fire, FIRE_CD = seconds between launches
    IDENTIFY: { TIME: 20, D_REF: 10, MIN: 5, MAX: 90 } // TIME = seconds at D_REF nm for a normal (RCS_REF) contact
  };
  const STN = ["NAVIGATION", "SENSORS", "WEAPONS", "DEFENSE"];
  const norm = a => ((a % 360) + 360) % 360;
  const diff = (to, from) => { const d = norm(to - from); return d > 180 ? d - 360 : d; };

  function newDef() { return { decoy: CFG.DEFENSE.DECOY.AMMO, sam: CFG.DEFENSE.SAM.AMMO, cd: 0, samCd: 0, ciws: null, ciwsOn: null, ecm: false, sams: [] }; } // defense state shared by every unit; ciws = manual target uid (null = auto), ciwsOn = uid engaged now; sams = pending intercepts
  const newLoadout = () => [{ w: "ssm", ammo: 8 }, { w: "asm", ammo: 4 }]; // missiles per weapon id; every unit carries one
  const slotOf = (u, w) => u.loadout.find(l => l.w === w);
  function initUnit(u, team, ctl, seed) { u.loadout = newLoadout(); u.team = team; u.ctl = ctl; u.rng = { seed: seed | 0 }; u.dead = [false, false, false, false]; u.sunk = false; u.wreck = false; u.ecm = false; u.fire = null; u.fireMsg = ""; u.def = newDef(); u.radar = ctl === "human" ? (u.radar || newRadar(seed)) : newRadar(seed ^ 0x2545); u.esmS = newEsm(seed ^ 0x5bd1); if (u.ordSpd === undefined) { u.ordSpd = u.spd || 0; u.ordHdg = u.hdg || 0; } return u; } // ctl = "human" | "ai": who issues this unit's commands
  function newShip() { return initUnit({ fixes: [], linkMsg: "", rel: "host", x: 0, y: 0, hdg: 0, spd: 0, ordHdg: 0, ordSpd: 0,
    fire: null, fireMsg: "", nMsl: 0,
    nEnemy: 0, nAlly: 0, hitSeq: 0, hitMsg: "", uid: 0 }, "blue", "human", 20261113); } // x east nm, y north nm

  function step(s, dt) {
    if (s.wreck) return;
    const ds = s.ordSpd - s.spd, ma = (s.sunk ? CFG.DAMAGE.DRIFT_DECEL : CFG.ACCEL) * dt;
    s.spd = Math.abs(ds) <= ma ? s.ordSpd : s.spd + Math.sign(ds) * ma;
    const f = Math.max(CFG.TURN_MIN, Math.min(1, Math.abs(s.spd) / CFG.TURN_FULL_AT));
    const dh = diff(s.ordHdg, s.hdg), mt = CFG.TURN * f * dt;
    s.hdg = norm(Math.abs(dh) <= mt ? s.ordHdg : s.hdg + Math.sign(dh) * mt);
    advance(s, dt);
    if (s.sunk && s.spd === 0) s.wreck = true; // stopped: permanent wreck
  }

  // ---- radar ----
  // ---- track table: what a unit knows about each other unit, one record per foe, the same structure for the human ship and for AI units (ship.trk / ai.trk) ----
  function newTrk() { return { seen: false, tracked: false, q: 0, px: 0, py: 0, lastHit: -1e9, cls: "unk", identified: false, idActive: false, idProg: 0, idNote: "", esm: null, esmNo: 0, known: null }; } // px/py = last detected position; cls = tag; known = identification result (AI use)
  const LINKED = ["seen", "tracked", "q", "px", "py", "lastHit", "cls", "identified", "idActive", "idProg", "idNote", "esm", "esmNo"]; // names the UI and tests still read on a contact: they point into the human ship's record
  function linkTrk(c, r) { for (const f of LINKED) { const d = Object.getOwnPropertyDescriptor(c, f); if (d && "value" in d) r[f] = d.value; Object.defineProperty(c, f, { get() { return r[f]; }, set(v) { r[f] = v; }, enumerable: false, configurable: true }); } }
  function trkOf(u, c) { const k = c.id === undefined ? "own" : c.id, T = u.ai ? u.ai.trk : (u.trk || (u.trk = {})); let r = T[k]; if (!r) { r = T[k] = newTrk(); if (u.ctl === "human") linkTrk(c, r); } return r; } // the unit's record for contact c (made on first use)
  const peekTrk = (u, c) => { const T = u.ai ? u.ai.trk : u.trk; return T && T[c.id === undefined ? "own" : c.id]; }; // the unit's record for c if one exists (does not create)
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
    return { id, loadout: newLoadout(), cat: "SRF", side: o.side || "unk", rcs: o.rcs || 10000, h: o.h || 60,
      x: Math.sin(a) * range, y: Math.cos(a) * range,
      hdg: o.course || 0, spd: o.speed || 0,                  // optional motion (kt)
      emit: o.emit || null, emitting: !!o.emit, esm: null, esmNo: 0, // emit = {name, range}; esm = last ESM bearing

      // side (hidden truth): "unk" = neutral/unknown, "ally", "enemy". cls = current tag; identified = permanent ID.
      cls: "unk", identified: false, idActive: false, idProg: 0, idNote: "", // idNote: "" | "lost" | "emcon" (interrupted)
      seen: false, tracked: false, q: 0, px: 0, py: 0, lastHit: -1e9 };
  }
  const rcsOf = f => f.rcs || CFG.AI.SHIP_RCS; // radar cross section of any unit (the player ship and the ally use the default)
  function pDetectU(u, f, d) { // chance that unit u's radar detects f at distance d on one pass of the beam: flat horizon cap, then RCS and range
    const R = CFG.RADAR; if (d > R.HORIZON) return 0;
    const rd = (u && u.emit ? u.emit.range : R.RANGE) * Math.pow(rcsOf(f) / R.RCS_REF, 0.25);
    return 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd)));
  }
  function pDetect(d, c) { return pDetectU(null, c, d); }
  // THE radar driver (human ship and AI units alike): the beam r (ang, t, seed, on) turns; a foe it passes is rolled once. on=false: beam turns, nothing detected, tracks take the miss penalty.
  function radarSweep(u, r, foes, dt) {
    const inc = 360 / CFG.RADAR.PERIOD * dt, a0 = r.ang;
    r.ang = norm(a0 + inc); r.t += dt;
    for (const c of foes) {
      if (c.sunk && !isShip(c)) { const t0 = peekTrk(u, c); if (t0) { t0.tracked = false; t0.q = 0; t0.idActive = false; } continue; } // destroyed: no longer tracked
      const t = trkOf(u, c);
      const dx = c.x - u.x, dy = c.y - u.y;
      const b = norm(Math.atan2(dx, dy) * 180 / Math.PI), sd = norm(b - a0);
      if (sd <= 0 || sd > inc) continue;               // beam did not pass this foe
      if (r.on && rand(r) < pDetectU(u, c, Math.hypot(dx, dy))) {
        const first = !t.tracked;
        t.q += (1 - t.q) * CFG.RADAR.Q_HIT; t.lastHit = r.t;
        t.px = c.x; t.py = c.y; t.seen = true; t.lk = false;
        if (first) { t.tracked = true; if (u.ctl === "human" && !t.identified) t.cls = c.side === "ally" ? "ally" : "unk"; }
      } else if (t.tracked) {
        t.q -= CFG.RADAR.Q_MISS;
        if (t.q < CFG.RADAR.Q_DROP) { t.tracked = false; t.q = 0; if (!t.identified) t.cls = "unk"; }
      }
    }
  }
  function radarStep(r, ship, contacts, dt) { radarSweep(ship, r, contacts, dt); } // legacy signature
  function steer(c, want, dt) { const dh = diff(want, c.hdg), mt = CFG.AI.TURN * dt; c.hdg = norm(Math.abs(dh) <= mt ? want : c.hdg + Math.sign(dh) * mt); }
  function huntMove(c, a) { // hunting (id / engage): close in at flank, then hold at the edge of its detection (HOLD x radar range); too close = open range, inside the band = circle
    const dx = a.lx - c.x, dy = a.ly - c.y, d = Math.hypot(dx, dy), hold = CFG.AI.HOLD * c.emit.range, to = norm(Math.atan2(dx, dy) * 180 / Math.PI);
    let want = to, spd = CFG.FLANK;
    if (a.tracks) { if (d < hold - CFG.AI.BAND) { want = norm(to + 180); spd = CFG.CRUISE; } else if (d <= hold + CFG.AI.BAND) { want = norm(to + 90); spd = CFG.CRUISE; } }
    else if (d < 1) { want = c.hdg; spd = CFG.CRUISE; } // reached the last known position, nothing there
    return { want, spd };
  }
  const advance = (u, dt) => { if (!u.spd) return; const r = u.hdg * Math.PI / 180, d = u.spd * dt / 3600; u.x += Math.sin(r) * d; u.y += Math.cos(r) * d; }; // move along the current heading
  function drift(u, dt) { u.spd = Math.max(0, u.spd - CFG.DAMAGE.DRIFT_DECEL * dt); if (!u.spd) u.wreck = true; } // destroyed: decelerates, no steering, then a wreck
  function aiOrders(u, ship) { // the AI "controller": returns {want (heading), spd, snap?} or null (hold course/speed). Same for enemies and the ally; u.escort = holds a formation slot beside the player ship while not hunting
    const a = u.ai, st = a && a.state;
    if (st === "inv" && !u.escort) return { want: a.hb, spd: CFG.FLANK }; // investigating: flank along the ESM bearing (no range known)
    if (st === "id" || st === "engage") return huntMove(u, a); // hunting: escort units leave the slot, back in it when they give up (patrol)
    if (u.escort && ship) { // formation slot CFG.ALLY.OFFSET nm abeam (starboard) of the player ship
      const r = (ship.hdg + 90) * Math.PI / 180, dx = ship.x + Math.sin(r) * CFG.ALLY.OFFSET - u.x, dy = ship.y + Math.cos(r) * CFG.ALLY.OFFSET - u.y, d = Math.hypot(dx, dy);
      if (d < 0.2) return { want: ship.hdg, spd: ship.spd };
      return { want: norm(Math.atan2(dx, dy) * 180 / Math.PI), spd: Math.min(CFG.FLANK, Math.max(0, ship.spd) + 20 * d) }; }
    if (a && a.wp) { // patrol: steer to the next waypoint (loop)
      const w = a.wp[a.i], dx = w[0] - u.x, dy = w[1] - u.y;
      if (Math.hypot(dx, dy) < CFG.AI.WP_NM) a.i = (a.i + 1) % a.wp.length;
      return { want: norm(Math.atan2(dx, dy) * 180 / Math.PI), spd: CFG.CRUISE }; }
    return null; }
  function stepUnit(u, dt, ship) { // SCALED dt: one movement step for any unit. Everyone moves with the same physics (`step`: ordered course/speed, accel, speed-dependent turn); an AI controller
    // only issues orders, through the same set_course / set_speed commands a player uses (refused when NAVIGATION is destroyed: the unit then holds its last orders).
    if (u.wreck) return;
    if (u.ordSpd === undefined) { u.ordSpd = u.spd || 0; u.ordHdg = u.hdg || 0; }
    if (u.ctl !== "human") {
      if (u.sunk) { u.ordSpd = 0; u.ordHdg = u.hdg; }
      else { const o = aiOrders(u, ship), nav = !(u.dead && u.dead[0]);
        const hdg = o ? o.want : u.hdg, spd = o ? o.spd : u.spd; // no orders = hold the current course and speed
        if (nav) { if (u.dead) { const ctx = { contacts: [], missiles: [] }; command(u, { type: "set_course", hdg }, ctx); command(u, { type: "set_speed", kt: spd }, ctx); } else { u.ordHdg = norm(hdg); u.ordSpd = spd; } } }
    }
    step(u, dt);
  }
  function stepContact(c, dt) { stepUnit(c, dt); }
  // ---- ESM ----
  function newEsm(seed) { return { t: 0, acc: 0, n: 0, seed: seed | 0 }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(Math.max(rand(r), 1e-12))) * Math.cos(2 * Math.PI * rand(r)); }
  function pEsm(d, c) {
    const E = CFG.ESM;
    if (!c.emit || !c.emitting) return 0;
    if (d > CFG.RADAR.HORIZON * E.DUCT) return 0; // ESM hears a little past the radar horizon (ducting)
    const rd = E.RANGE_FACTOR * c.emit.range;
    return 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd)));
  }
  // THE ESM driver (human ship and AI units): every INTERVAL s each foe's emission is rolled; a hit stores a noisy bearing (smoothed) in the unit's record for that foe (rec.esm), held HOLD s.
  // key "esm" = the unit's own track record; any other key (legacy: ally LINK bearings "esmA") = a field on the foe itself.
  function esmSweep(u, e, foes, dt, key) {
    key = key || "esm"; const E = CFG.ESM; e.t += dt; e.acc += dt;
    while (e.acc >= E.INTERVAL) {
      e.acc -= E.INTERVAL;
      for (const c of foes) {
        if (c.sunk && !isShip(c)) continue;
        const er = emitOf(c), dx = c.x - u.x, dy = c.y - u.y, t = key === "esm" ? trkOf(u, c) : c;
        if (er > 0 && rand(e) < pEsm(Math.hypot(dx, dy), { emit: { range: er }, emitting: true })) {
          const b = norm(Math.atan2(dx, dy) * 180 / Math.PI + gauss(e) * E.SIGMA);
          if (!t.esmNo && key === "esm") t.esmNo = ++e.n;
          t[key] = { brg: t[key] ? norm(t[key].brg + 0.4 * diff(b, t[key].brg)) : b, t: e.t }; // light smoothing
        }
        if (t[key] && e.t - t[key].t > E.HOLD) t[key] = null;
      }
    }
  }
  function esmStep(e, ship, contacts, dt, key) { esmSweep(ship, e, contacts, dt, key); } // legacy signature
  function setTag(c, cls) { if (!c.tracked || c.identified) return false; c.cls = cls; return true; } // identified = tag locked
  // ---- identify (same routine for the human ship and AI units; works on the unit's track record for the foe) ----
  function startIdent(t) { if (!t.tracked || t.identified || t.known || t.idActive) return false; t.idActive = true; t.idProg = 0; t.idNote = ""; return true; }
  function startIdentify(c) { return startIdent(c); } // c = a track record or a contact whose legacy names point into one
  function identTime(u, f) { // seconds needed now: grows with range, and with low RCS (RCS_REF/rcs)^0.25
    const I = CFG.IDENTIFY, d = Math.hypot(f.x - u.x, f.y - u.y);
    return Math.max(I.MIN, Math.min(I.MAX, I.TIME * (0.6 + 0.4 * d / I.D_REF) * Math.pow(CFG.RADAR.RCS_REF / rcsOf(f), 0.25)));
  }
  function identifyTime(c, ship) { return identTime(ship, c); }
  function cancelIdentify(c) { c.idActive = false; c.idProg = 0; c.idNote = ""; }
  const truthOf = (u, f) => u.ctl === "human" ? (f.side === "ally" ? "ally" : f.side === "enemy" ? "host" : "unk") : relOf(f); // what identification reveals to this unit
  function identifySweep(u, foes, dt, radarOn) { // REAL dt. Radar silent (EMCON) interrupts at once; track lost interrupts and resets progress
    if (radarOn === undefined) radarOn = u.radar ? u.radar.on : true;
    for (const c of foes) {
      const t = peekTrk(u, c);
      if (!t || !t.idActive) continue;
      if (c.sunk && !isShip(c)) { t.idActive = false; t.idProg = 0; continue; }
      if (!radarOn) { t.idActive = false; t.idProg = 0; t.idNote = "emcon"; continue; }
      if (!t.tracked) { t.idActive = false; t.idProg = 0; t.idNote = "lost"; continue; }
      t.idProg += dt / identTime(u, c); // idProg is a fraction 0..1
      if (t.idProg >= 1) {
        const tr = truthOf(u, c); t.idActive = false; t.idProg = 0; t.identified = true; t.idNote = "";
        t.known = tr === "host" ? "host" : tr === "ally" ? "ally" : "neutral"; t.cls = tr; // reveals the hidden truth, tag locked
      }
    }
  }
  function identifyStep(contacts, dt, radarOn, ship) { identifySweep(ship, contacts, dt, radarOn); } // legacy signature
  // ---- weapons: select target + weapon, countdown, launch. A launched missile flies toward the target's last known position. ----
  function fireCheck(ship, slot, c) { // "" if OK, else the reason it can't fire
    if (ship.dead[2]) return "Weapons station destroyed.";
    if (slot == null) return "Select a weapon.";
    if (!c) return "Select a tracked contact.";
    if (!c.tracked) return "Target not tracked.";
    if (c.sunk) return "Target destroyed.";
    const L = ship.loadout[slot], W = CFG.WEAPONS[L.w];
    if (L.ammo <= 0) return "No ammo.";
    const d = Math.hypot(c.px - ship.x, c.py - ship.y);
    if (d > W.range) return "Out of range: " + d.toFixed(1) + " / " + W.range + " NM.";
    return "";
  }
  function startFire(ship, slot, c) {
    if (ship.fire || fireCheck(ship, slot, c)) return false;
    // mk: a FIX marker expires in 5 s, so keep its point for the countdown
    ship.fire = { slot, tid: c.id, t: CFG.WEAPON.COUNTDOWN, mk: c.marker ? { id: c.id, marker: true, tracked: true, seen: true, px: c.px, py: c.py } : null }; ship.fireMsg = ""; return true;
  }
  function cancelFire(ship) { if (ship.fire) { ship.fire = null; ship.fireMsg = "Launch aborted."; } }
  function launchMissile(u, w, o, missiles, ship) { // the one place a missile entity is made, for the human ship and AI units alike. o = {tid, hdg?, tx?, ty?}; counters live on the player ship
    const W = CFG.WEAPONS[w], L = slotOf(u, w); L.ammo--;
    const human = u.ctl === "human", red = !human && u.team !== ship.team, n = human ? ++ship.nMsl : red ? ++ship.nEnemy : ++ship.nAlly;
    const m = { uid: ++ship.uid, n, side: human ? "own" : red ? "enemy" : "ally", w, tid: o.tid, x: u.x, y: u.y, hdg: o.hdg !== undefined ? o.hdg : u.hdg, spd: W.speed, fuel: W.range };
    if (!human) m.lbl = (red ? "H" : "A") + n;
    if (o.tx !== undefined) { m.tx = o.tx; m.ty = o.ty; } // fixed aim point (FIX marker): flies there, its seeker looks for a ship
    missiles.push(m); return m;
  }
  function fireStep(ship, contacts, missiles, dt, pship) { // real-time dt, once per frame, for any unit (pship = the player ship, default = the unit itself). Returns the missile launched, if any
    const f = ship.fire; if (!f) return null;
    const c = contacts.find(k => k.id === f.tid) || f.mk, why = fireCheck(ship, f.slot, c);
    if (why) { ship.fire = null; ship.fireMsg = "Launch aborted: " + why; return null; } // track lost, out of range...
    f.t -= dt; if (f.t > 0) return null;
    const L = ship.loadout[f.slot], human = ship.ctl === "human";
    ship.fire = null; ship.fireMsg = "";
    // human at a contact: guided to the live track. FIX marker: a fixed point. AI units always fly to the last known position (tx/ty); the seeker finds the real ship only within its radius
    const o = c.marker ? (human ? { tid: "mk", tx: c.px, ty: c.py } : { tid: "own", tx: c.px, ty: c.py }) : human ? { tid: c.id } : { tid: c.id, tx: c.px, ty: c.py };
    if (!human) o.hdg = norm(Math.atan2(c.px - ship.x, c.py - ship.y) * 180 / Math.PI);
    const m = launchMissile(ship, L.w, o, missiles, pship || ship);
    if (c.ai && !c.sunk) aiProvoke(c, pship || ship);
    return m;
  }
  function aiProvoke(c, ship) { const a = c.ai; a.known = "host"; a.state = "engage"; a.idp = 0; a.lost = 0; a.lx = ship.x; a.ly = ship.y; } // fired at: tagged hostile at once, it hunts us and fires back (needs its normal track to launch)
  // ---- damage ----
  function sink(ship) { ship.sunk = true; ship.dead = [true, true, true, true]; ship.ordSpd = 0; ship.ordHdg = ship.hdg; ship.fire = null; }
  function hitShip(ship, prof) { // enemy missile reaches the ship: roll the hit, then which stations are lost. Returns {hit, lost:[station idx], sunk}
    const D = CFG.DAMAGE, P = D[prof], res = { hit: false, lost: [], sunk: false };
    if (ship.sunk || rand(ship.rng) >= D.P_HIT) return res;
    res.hit = true;
    const pool = [0, 1, 2, 3].filter(i => !ship.dead[i] && (i > 0 || P.nav));
    const n = rand(ship.rng) < P.second ? 2 : 1;
    for (let k = 0; k < n && pool.length; k++) res.lost.push(pool.splice(Math.floor(rand(ship.rng) * pool.length), 1)[0]);
    for (const i of res.lost) ship.dead[i] = true;
    if (ship.dead.filter(d => !d).length <= 1) { sink(ship); res.sunk = true; }
    return res;
  }
  function debugMissile(ship, missiles, w) { // test: enemy missile from DEBUG_DIST nm, random bearing, aimed at own ship
    const W = CFG.WEAPONS[w], b = rand(ship.rng) * 360, a = b * Math.PI / 180, d = CFG.DAMAGE.DEBUG_DIST;
    ++ship.nEnemy;
    missiles.push({ uid: ++ship.uid, n: ship.nEnemy, lbl: "H" + ship.nEnemy, side: "enemy", w, tid: "own", x: ship.x + Math.sin(a) * d, y: ship.y + Math.cos(a) * d, hdg: norm(b + 180), spd: W.speed, fuel: W.range });
  }
  function resetShip(ship) { ship.def = newDef(); ship.loadout = newLoadout(); ship.ecm = false;
    ship.dead = [false, false, false, false]; ship.link = false; ship.radar.on = true; ship.holds = null; ship.sunk = false; ship.wreck = false; ship.fire = null; ship.fireMsg = ""; ship.hitMsg = ""; }
  function stepMissiles(missiles, contacts, dt, ship, ally) { // scaled dt. tid "own" = aimed at the own ship (true position). Others: last known position, no damage yet
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i], W = CFG.WEAPONS[m.w], own = m.tid === "own";
      if (m.state === "dead") continue;                                   // destroyed: frozen, removed by reap()
      if (m.state === "decoy" || m.state === "jam") {                                         // seduced: flies straight, no guidance, no hit
        const d = m.spd * dt / 3600, r = m.hdg * Math.PI / 180; m.x += Math.sin(r) * d; m.y += Math.cos(r) * d; m.fuel -= d;
        if (m.fuel <= 0 || Math.hypot(m.x - ship.x, m.y - ship.y) > CFG.DEFENSE.STRAY) missiles.splice(i, 1);
        continue; }
      const atAl = m.tid === "A1" && ally, fixed = m.tid === "mk", c = own || fixed || atAl ? null : contacts.find(k => k.id === m.tid);
      let tr = c && m.side !== "own" ? { x: c.x, y: c.y } : c ? { x: c.px, y: c.py } : null; // enemy missiles at allies use true position
      if (own) { if (m.tx !== undefined && Math.hypot(ship.x - m.x, ship.y - m.y) <= W.seeker) m.tx = undefined; // aimed at a fix: seeker acquires the ship once close enough
        tr = m.tx !== undefined ? { x: m.tx, y: m.ty } : { x: ship.x, y: ship.y }; }
      else if (fixed) tr = { x: m.tx, y: m.ty };
      else if (atAl) tr = { x: ally.x, y: ally.y }; // enemy missile at the ally: true position
      const tu = atAl ? ally : c && m.side === "ally" ? c : null; // AI missile at a unit: flies to the last known point (tx/ty) until its seeker finds the real unit
      if (tu && m.tx !== undefined) { if (Math.hypot(tu.x - m.x, tu.y - m.y) <= W.seeker) m.tx = undefined; else tr = { x: m.tx, y: m.ty }; }
      if (!tr) { missiles.splice(i, 1); continue; }
      if (c && c.sunk && m.side !== "enemy") { missiles.splice(i, 1); continue; } // target already destroyed
      const dx = tr.x - m.x, dy = tr.y - m.y;
      if (Math.hypot(dx, dy) < CFG.WEAPON.ARRIVE) {
        if (own) { if (m.tx !== undefined) { ship.hitSeq++; ship.hitMsg = (m.lbl || "M" + m.n) + " MISSED"; } // reached the fix without finding us
          else { const r = hitShip(ship, W.dmg); ship.hitSeq++;
            ship.hitMsg = (m.lbl || "M" + m.n) + (!r.hit ? " MISSED" : r.sunk ? " HIT: SHIP DESTROYED" : " HIT: " + r.lost.map(k => STN[k]).join(" + ") + " DESTROYED"); } }
        else if (atAl) { const r = m.tx !== undefined ? { hit: false } : hitShip(ally, W.dmg); ship.hitSeq++; // enemy missile reaches the ally: same station rules as ours (a miss if the seeker never found it)
          ship.hitMsg = (m.lbl || "H" + m.n) + " > A1" + (!r.hit ? " MISSED" : r.sunk ? " HIT: SHIP DESTROYED" : " HIT: " + r.lost.map(k => STN[k]).join(" + ") + " DESTROYED"); }
        else if (m.side === "ally" && c && c.dead) { const r = m.tx !== undefined ? { hit: false } : hitShip(c, W.dmg); ship.strikeSeq = (ship.strikeSeq || 0) + 1; // the ally's missile reaches its target (true position): same station rules
          ship.strikeMsg = (m.lbl || "A" + m.n) + " > TRK " + String(c.id).padStart(4, "0") + (!r.hit ? " MISSED" : r.sunk ? " HIT: SHIP DESTROYED" : " HIT: " + r.lost.map(k => STN[k]).join(" + ") + " DESTROYED"); }
        else if (m.side === "own" && (fixed || (c && c.dead))) { // our missile reaches its aim point (last known position / FIX): hits only a ship really within the seeker radius
          const dd = k => Math.hypot(k.x - m.x, k.y - m.y), v = fixed ? contacts.filter(k => k.dead && !k.sunk && dd(k) <= W.seeker).sort((a, b) => dd(a) - dd(b))[0] : (dd(c) <= W.seeker ? c : null);
          const lbl = (m.lbl || "M" + m.n) + " > " + (fixed ? "FIX" : "TRK " + String(c.id).padStart(4, "0")); const r = v ? hitShip(v, W.dmg) : null;
          ship.strikeSeq = (ship.strikeSeq || 0) + 1;
          ship.strikeMsg = lbl + (!r || !r.hit ? " MISSED" : r.sunk ? " HIT: SHIP DESTROYED" : " HIT: " + r.lost.map(k => STN[k]).join(" + ") + " DESTROYED"); }
        missiles.splice(i, 1); continue;
      }
      const want = norm(Math.atan2(dx, dy) * 180 / Math.PI), dh = diff(want, m.hdg), mt = W.turn * dt;
      m.hdg = norm(Math.abs(dh) <= mt ? want : m.hdg + Math.sign(dh) * mt); // turn-rate limited, so it curves on the scope
      const d = m.spd * dt / 3600, r = m.hdg * Math.PI / 180;
      m.x += Math.sin(r) * d; m.y += Math.cos(r) * d; m.fuel -= d;
      if (m.fuel <= 0) missiles.splice(i, 1); // out of fuel
    }
  }

  // ---- defense ----
  const live = m => m.side === "enemy" && !m.state;
  const mdist = (ship, m) => Math.hypot(m.x - ship.x, m.y - ship.y);
  function defCheck(ship) { return ship.dead[3] ? "Defense station destroyed." : ""; }
  function seduce(ship, m, st) { m.state = st; m.hdg = norm(m.hdg + (rand(ship.rng) < 0.5 ? -1 : 1) * (15 + rand(ship.rng) * 15)); } // loses guidance, veers off, flies straight
  function toggleEcm(ship, emcon) { // emcon = radar silent by choice: jamming is an emission, so it is not allowed (and is forced off when EMCON starts)
    const why = defCheck(ship); if (why) return why;
    if (emcon) { ship.def.ecm = false; return "EMCON active: jamming unavailable."; }
    ship.def.ecm = !ship.def.ecm; return CFG.DEFENSE.ECM.NAME + (ship.def.ecm ? " jamming ON." : " OFF."); }
  function deployDecoy(ship, missiles, mine) { // returns message. Each incoming missile aimed at us rolls P; success = decoyed. mine(m) = which missiles count (default: live and aimed at the player ship)
    const D = CFG.DEFENSE.DECOY, df = ship.def, why = defCheck(ship), hit = mine || (m => live(m) && m.tid === "own");
    if (why) return why; if (df.decoy <= 0) return "No decoys left."; if (df.cd > 0) return "Decoy reloading: " + Math.ceil(df.cd) + " s.";
    df.decoy--; df.cd = D.CD; let n = 0, near = 0;
    for (const m of missiles) if (hit(m) && mdist(ship, m) <= D.RANGE) { near++; if (rand(ship.rng) < D.P) { seduce(ship, m, "decoy"); n++; } } // only missiles inside RANGE can be seduced
    return n ? "Decoy deployed: " + n + " missile(s) seduced." : near ? "Decoy deployed: no effect." : "Decoy deployed: no missile within " + D.RANGE + " NM.";
  }
  function launchSam(ship, missiles, uid, mine) { // mine(m) = which missiles may be engaged (default: any live enemy missile)
    const S = CFG.DEFENSE.SAM, m = missiles.find(k => k.uid === uid), why = defCheck(ship), ok = mine || live;
    if (why) return why; if (!m || !ok(m)) return "Select a live incoming missile."; if (ship.def.sam <= 0) return "No SAM ammo."; if ((ship.def.samCd || 0) > 0) return "SAM reloading: " + Math.ceil(ship.def.samCd) + " s.";
    const d = mdist(ship, m); if (d > S.RANGE) return "Out of SAM range: " + d.toFixed(1) + " / " + S.RANGE + " NM.";
    ship.def.sam--; ship.def.samCd = S.RELOAD; ship.def.sams.push({ uid, x: ship.x, y: ship.y, hdg: norm(Math.atan2(m.x - ship.x, m.y - ship.y) * 180 / Math.PI) }); return "SAM launched.";
  }
  function setCiws(ship, uid) { ship.def.ciws = uid == null ? null : uid; } // manual target (even out of range) disables auto
  function stepDefense(ship, missiles, dt) { // SCALED dt: only SAM flight speed (time button affects speeds only)
    const df = ship.def, S = CFG.DEFENSE;
    if (ship.dead[3]) { df.ciwsOn = null; df.ecm = false; ship.def.sams.length = 0; return; }
    for (let i = ship.def.sams.length - 1; i >= 0; i--) { const q = ship.def.sams[i], m = missiles.find(k => k.uid === q.uid); // SAM flies straight at its target
      if (!m || m.state) { ship.def.sams.splice(i, 1); continue; }
      const dx = m.x - q.x, dy = m.y - q.y, dd = Math.hypot(dx, dy), mv = S.SAM.SPEED * dt / 3600; q.hdg = norm(Math.atan2(dx, dy) * 180 / Math.PI);
      if (dd <= mv + 0.3) { ship.def.sams.splice(i, 1); if (rand(ship.rng) < S.SAM.P) { m.state = "dead"; m.dieT = S.X_TIME; } continue; }
      q.x += dx / dd * mv; q.y += dy / dd * mv; }
  }
  function reloadStep(u, dt) { u.def.cd = Math.max(0, u.def.cd - dt); u.def.samCd = Math.max(0, (u.def.samCd || 0) - dt); } // decoy and SAM reload timers (real dt)
  function ciwsStep(ship, missiles, dt, mine, noReload) { // REAL dt: decoy reload and CIWS rolls are not sped up by the time button. mine(m) = missiles it may shoot at (default: live enemy missiles)
    const df = ship.def, S = CFG.DEFENSE, ok = mine || live; if (!noReload) reloadStep(ship, dt);
    if (ship.dead[3]) { df.ciwsOn = null; return; }
    let tg = null;
    if (df.ciws != null) { tg = missiles.find(k => k.uid === df.ciws && ok(k)); if (!tg) df.ciws = null; } // manual target gone: back to auto
    if (df.ciws == null) { let bd = 1e9; for (const m of missiles) if (ok(m)) { const d = mdist(ship, m); if (d <= S.CIWS.RANGE && d < bd) { bd = d; tg = m; } } }
    df.ciwsOn = null;
    if (tg && mdist(ship, tg) <= S.CIWS.RANGE) { df.ciwsOn = tg.uid; if (rand(ship.rng) < 1 - Math.pow(1 - S.CIWS.P, dt)) { tg.state = "dead"; tg.dieT = S.X_TIME; } }
  }
  function ecmStep(ship, missiles, dt, mine) { // REAL-time dt (not the Time button): jamming chance per real second. mine(m) = which missiles it jams (default: live and aimed at the player ship)
    const S = CFG.DEFENSE; if (!ship.def.ecm || ship.dead[3]) return;
    for (const m of missiles) if (!m.state && (mine ? mine(m) : m.side === "enemy" && m.tid === "own") && mdist(ship, m) <= S.ECM.RANGE && rand(ship.rng) < 1 - Math.pow(1 - S.ECM.P, dt)) seduce(ship, m, "jam");
  }
  function reap(missiles, dt) { for (let i = missiles.length - 1; i >= 0; i--) { const m = missiles[i]; if (m.state === "dead" && (m.dieT -= dt) <= 0) missiles.splice(i, 1); } } // real dt
  // ---- LINK, ally, ESM fixes ----
  function toggleLink(ship, emcon) { if (ship.dead[1]) return "Sensors destroyed."; if (emcon) { ship.link = false; return "EMCON active: LINK unavailable."; } ship.link = !ship.link; return "LINK " + (ship.link ? "ON." : "OFF."); } // LINK is an emission: off under EMCON
  function newAlly(x, y) { return initUnit({ id: "A1", escort: true, emit: { name: "AN/SPY-1D", range: CFG.RADAR.RANGE }, emitting: false, ai: newAi(99, null), x, y, hdg: 0, spd: 0 }, "blue", "ai", 77); }
  function resetAlly(al, x, y) { al.x = x; al.y = y; al.hdg = 0; al.spd = 0; al.ordHdg = 0; al.ordSpd = 0; al.dead = [false, false, false, false]; al.sunk = false; al.wreck = false; al.ecm = false; al.fire = null; al.def = newDef(); al.loadout = newLoadout(); al.emitting = false; if (al.ai) resetAi(al.ai); }
  function allyStep(al, ship, dt) { stepUnit(al, dt, ship); } // the ally = an AI unit with escort:true
  function rays(x1, y1, b1, x2, y2, b2) { // where two bearing rays (deg, north = 0) cross; null if near parallel, behind an observer, or too far
    const a = b1 * Math.PI / 180, c = b2 * Math.PI / 180, ax = Math.sin(a), ay = Math.cos(a), bx = Math.sin(c), by = Math.cos(c), det = bx * ay - ax * by, ex = x2 - x1, ey = y2 - y1;
    if (Math.abs(det) < CFG.FIX.MIN_SIN) return null;
    const t1 = (bx * ey - by * ex) / det, t2 = (ax * ey - ay * ex) / det, M = CFG.FIX.MAXR;
    if (t1 <= 0 || t2 <= 0 || t1 > M || t2 > M) return null;
    return { x: x1 + t1 * ax, y: y1 + t1 * ay };
  }
  function fixStep(fixes, ship, ally, contacts, esm, esmA, dt) { // REAL dt: our ESM line and the ally's (LINK) both fresh and crossing -> marker (one per emitter) for FIX.LIFE s
    const F = CFG.FIX;
    for (const c of contacts) { if (!c.emit || !c.esm || !c.esmA || esm.t - c.esm.t > F.FRESH || esmA.t - c.esmA.t > F.FRESH) continue;
      const p = rays(ship.x, ship.y, c.esm.brg, ally.x, ally.y, c.esmA.brg); if (!p) continue;
      let f = fixes.find(k => k.emId === c.id);
      if (!f) { f = { id: "F" + c.id, emId: c.id, marker: true, seen: true, tracked: true, identified: true, cls: "unk", q: 1, esmNo: c.esmNo }; fixes.push(f); }
      f.x = f.px = p.x; f.y = f.py = p.y; f.t = F.LIFE; }
    for (let i = fixes.length - 1; i >= 0; i--) if ((fixes[i].t -= dt) <= 0) fixes.splice(i, 1);
  }
  function aiFixStep(contacts, dt) { // REAL dt: linked enemies cross their ESM bearings on us; the marker is shared, and counts as hostile if any of them knows we are
    const F = CFG.FIX, L = contacts.filter(c => c.ai && !c.sunk && !(c.dead && c.dead[1]));
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i].ai, b = L[j].ai; if (!a.hears || !b.hears || a.t - a.hears.t > F.FRESH || b.t - b.hears.t > F.FRESH) continue;
      const p = rays(L[i].x, L[i].y, a.hears.brg, L[j].x, L[j].y, b.hears.brg); if (!p) continue;
      const host = L.some(k => k.ai.known === "host"); for (const k of [L[i], L[j]]) k.ai.fix = { x: p.x, y: p.y, t: F.LIFE, host }; }
    for (const c of contacts) if (c.ai && c.ai.fix && (c.ai.fix.t -= dt) <= 0) c.ai.fix = null;
  }
  // ---- enemy ship state: same station damage rules as ours, own defenses (SAM vs ASM; decoy, ECM, CIWS vs SSM) ----
  function initEnemy(c, seed) { initUnit(c, "red", "ai", seed); }
  function resetEnemy(c) { initEnemy(c, c.rng ? c.rng.seed : 1); if (c.ai) resetAi(c.ai); } // initUnit also refills the loadout
  function aiDefStep(c, missiles, dt) { defStep(c, missiles, dt, m => (m.side === "own" || m.side === "ally") && m.tid === c.id); } // missiles from the player or the ally
  function allyDefStep(al, missiles, dt) { defStep(al, missiles, dt, m => m.side === "enemy" && m.tid === al.id); } // ally defends itself with the same rules/numbers
  function defStep(c, missiles, dt, mine) { // REAL dt: reaction delay, decoy reload, ECM and CIWS rolls; mine(m) = missile is aimed at this unit
    const df = c.def, A = CFG.AI, S = CFG.DEFENSE; if (!df) return;
    reloadStep(c, dt); c.ecm = false;
    if (c.sunk || c.dead[3]) { df.sams.length = 0; df.ecm = false; df.ciwsOn = null; return; }
    const th = []; // our missiles aimed at it, inside SAM range, after its 2-5 s reaction delay
    for (const m of missiles) { if (m.state || !mine(m)) continue;
      const d = Math.hypot(m.x - c.x, m.y - c.y); if (d > S.SAM.RANGE) continue;
      if (m.aiT === undefined) m.aiT = A.REACT_MIN + rand(c.rng) * (A.REACT_MAX - A.REACT_MIN);
      if (m.aiT > 0) { m.aiT -= dt; continue; }
      th.push({ m, d }); }
    th.sort((a, b) => (b.m.w === "asm") - (a.m.w === "asm") || a.d - b.d);
    // the AI only decides; the actions are the same commands (and the same code) as the player's. Decoy, ECM and CIWS act on SSMs only; `mine` limits every command to the missiles it decided on
    const set = new Set(th.map(k => k.m)), ssmSet = new Set(th.filter(k => k.m.w === "ssm").map(k => k.m)), ctx = { radar: AI_RADAR, contacts: [], missiles }, cmd = (o, mine) => command(c, o, Object.assign({ mine }, ctx));
    for (const { m } of th) if (df.samCd <= 0 && !df.sams.some(q => q.uid === m.uid) && df.sam > 0) cmd({ type: "launch_sam", uid: m.uid }, k => set.has(k) && !k.state); // SAMs: ASMs first (sorted), then SSMs while ammo lasts
    const ssm = th.filter(k => k.m.w === "ssm");
    if (df.cd <= 0 && df.decoy > 0 && ssm.some(k => !k.m.state && k.d <= S.DECOY.RANGE)) cmd({ type: "deploy_decoy" }, k => ssmSet.has(k) && !k.state);
    const jm = ssm.some(k => !k.m.state && k.d <= S.ECM.RANGE); cmd({ type: "ecm", on: jm });
    if (jm) ecmStep(c, missiles, dt, k => ssmSet.has(k));
    c.ecm = !!df.ecm;
    ciwsStep(c, missiles, dt, k => ssmSet.has(k) && !k.state, true);
  }
  function aiSamMove(c, missiles, dt) { if (c.def) stepDefense(c, missiles, dt); } // SCALED dt: AI and ally SAM flight and hit roll = the same code as the player's
  const allySamMove = aiSamMove;
  // ---- enemy AI (first stage): patrol, duty-cycled radar, ESM; same sensor rules as the player, no weapons yet. Real-time dt ----
  const PRIM = { tracks: "tracked", q: "q", known: "known", idp: "idProg", lx: "px", ly: "py" }; // legacy AI names -> fields of the primary foe's record in a.trk (key "_" while no foe is bound yet)
  const prRec = a => a.trk[a.pid === null ? "_" : a.pid] || (a.trk[a.pid === null ? "_" : a.pid] = newTrk());
  function newAi(seed, wp) { const a = { seed: seed | 0, wp, i: 0, t: 0, sw: 0, es: 0, pid: null, trk: {}, hears: null, nHear: 0, cd: 0, fixCd: 0, state: "patrol", lost: 0, hb: 0, il: 0 };
    for (const k in PRIM) Object.defineProperty(a, k, { get() { return prRec(a)[PRIM[k]]; }, set(v) { prRec(a)[PRIM[k]] = v; }, enumerable: false });
    return a; } // state: patrol | inv (investigating an ESM bearing hb; il = real s since last heard) | id | engage; known: null | "host" | "neutral" (its identification of us); idp: identify progress 0..1; lx/ly: last detected position of us
  function aiIdTime(d) { const I = CFG.IDENTIFY; return Math.max(I.MIN, Math.min(I.MAX, I.TIME * (0.6 + 0.4 * d / I.D_REF) * Math.pow(CFG.RADAR.RCS_REF / CFG.AI.SHIP_RCS, 0.25))); } // same formula as ours
  function resetAi(a) { a.state = "patrol"; a.known = null; a.idp = 0; a.lost = 0; a.hb = 0; a.il = 0; a.hears = null; a.fix = null; a.pid = null; a.trk = {}; a.cd = 0; a.fixCd = 0; }
  // ---- team-agnostic AI: any unit with `ai` senses and fires at every unit of the other team (`team`) ----
  const keyOf = u => u.id === undefined ? "own" : u.id; // the player ship has no id
  const isShip = u => u.ctl === "human"; // the player ship = the unit under human control
  const relOf = u => isShip(u) ? u.rel : "host"; // how identification resolves: the player ship carries its own `rel`, every AI/contact unit counts as hostile
  const foesOf = (c, ship, ally, contacts) => [ship, ally].concat(contacts || []).filter(u => u && u !== c && u.team !== c.team); // player ship first
  function bindPrimary(a, foes) { // every foe has a record in a.trk[id]; the primary foe's record is also reachable through the legacy names a.tracks, a.q, a.known, a.idp, a.lx, a.ly
    const live = f => isShip(f) || !f.sunk;
    if (a.pid !== null && foes.some(f => keyOf(f) === a.pid && live(f))) return foes.find(f => keyOf(f) === a.pid);
    const P = foes.find(live), moved = a.pid !== null;
    a.pid = P ? keyOf(P) : null;
    if (P && !moved && a.trk._ && !a.trk[a.pid]) { a.trk[a.pid] = a.trk._; delete a.trk._; } // records made before any foe was bound belong to the first one
    if (moved) { if (a.pid !== null) a.trk[a.pid] = newTrk(); if (a.state !== "patrol") a.state = "patrol"; }
    return P;
  }
  const rec = (a, f) => a.trk[keyOf(f)] || (a.trk[keyOf(f)] = newTrk());
  function emitOf(f) { // what a unit radiates that an opposing ESM can hear (nm)
    if (isShip(f)) return Math.max(f.radar && f.radar.on && !f.dead[1] ? CFG.RADAR.RANGE : 0, f.def.ecm && !f.dead[3] ? CFG.DEFENSE.ECM.EMIT : 0, f.link && !f.dead[1] ? CFG.LINK.EMIT : 0); // radar, jamming, LINK
    return f.emitting && f.emit && !f.sunk && !(f.dead && f.dead[1]) ? f.emit.range : 0; }
  // LINK: while on (and our SENSORS alive) our radar tracks are shared with the linked friendly unit's AI picture: the ally "sees" what we track, at any distance.
  // Shared tracks refresh its record each call (quality = best of both); an identified contact (our tag hostile) is also known hostile to it.
  function linkShare(ship, al, contacts) {
    if (!ship.link || ship.dead[1] || !al || al.sunk || !al.ai || (al.dead && al.dead[1])) return;
    for (const t of Object.values(ship.trk || {}).concat(Object.values(al.ai.trk))) if (!t.tracked) t.lk = false; // a shared track that was dropped is gone (lk = copied from the partner, never re-shared: no feedback loop)
    for (const c of contacts) { if (c.sunk || c.marker) continue; const t = trkOf(ship, c); if (!t.tracked || t.lk) continue;
      const r = rec(al.ai, c); r.lk = true; r.tracked = true; r.q = Math.max(r.q, t.q); r.px = t.px; r.py = t.py;
      if (t.identified && r.known === null) r.known = t.cls === "host" ? "host" : "neutral";
    }
    for (const c of contacts) { if (c.sunk || c.marker) continue; const r = al.ai.trk[c.id]; if (!r || !r.tracked || r.lk || r.q <= CFG.RADAR.Q_DROP) continue; // ally -> us: its tracks appear in our picture (same record, shown like a radar track)
      const t = trkOf(ship, c), better = r.q > (t.tracked ? t.q : 0); t.seen = true; t.tracked = true; t.lk = true; if (better) { t.q = r.q; t.px = r.px; t.py = r.py; } t.lastHit = ship.radar ? ship.radar.t : t.lastHit; } }
  function aiStep(c, ship, dt, ally, contacts) {
    const a = c.ai, A = CFG.AI; if (!a) return;
    a.t += dt;
    const foes = foesOf(c, ship, ally, contacts); let P = bindPrimary(a, foes);
    if (c.sunk || (c.dead && c.dead[1])) { c.emitting = false; if (c.radar) c.radar.on = false; for (const k in a.trk) { if (k === String(a.pid)) { a.trk[k].tracked = false; a.trk[k].q = 0; } else delete a.trk[k]; } a.hears = null; if (a.state !== "patrol") { a.lost += dt; if (a.lost > A.GIVE_UP) { a.state = "patrol"; a.idp = 0; } } return; } // sensors destroyed: no radar, no ESM
    const unkT = () => Object.keys(a.trk).filter(k => k !== "_" && a.trk[k].tracked && a.trk[k].known === null); // tracked foes not yet identified
    if (!c.radar || c.radar.ang === undefined) c.radar = Object.assign(newRadar(a.seed ^ 0x2545), { on: c.radar ? c.radar.on : true }); // bare test contacts get a beam lazily
    if (!c.esmS) c.esmS = newEsm(a.seed ^ 0x5bd1);
    { const idle = Object.keys(a.trk).some(k => k !== "_" && a.trk[k].idActive && a.trk[k].tracked), want = idle || (a.state === "id" && unkT().length > 0) || (a.t % A.DUTY_PERIOD) < A.DUTY_ON; if (c.dead) command(c, { type: "radar", on: want }, { contacts: [], missiles: [] }); else c.radar.on = want; } c.emitting = c.radar.on; // same SENSORS command as a player. 20/60 duty cycle; exception: while identifying a tracked foe the radar stays ON until identified or the track is lost
    const D = f => Math.hypot(f.x - c.x, f.y - c.y); let d = P ? D(P) : Infinity;
    radarSweep(c, c.radar, foes, dt); // the shared radar driver (beam, rolls, quality, drops)
    if (P && a.tracks) { a.dist = D(P); a.brg = norm(Math.atan2(P.x - c.x, P.y - c.y) * 180 / Math.PI); }
    for (const k in a.trk) { if (k === "_") continue; const f = foes.find(u => String(keyOf(u)) === k), r = a.trk[k];
      if (!f || (!isShip(f) && f.sunk)) { if (k !== String(a.pid)) delete a.trk[k]; } else if (r.tracked && r.q < CFG.RADAR.Q_DROP) { r.tracked = false; r.q = 0; } }
    // per-foe identification, in parallel: for every tracked foe of unknown identity it issues the same `identify` command a player does (radar on, SENSORS alive); the shared
    // identify routine advances each one, losing a foe's track resets only that foe. The result lives in that foe's record (r.known), so switching foes never forgets it.
    { const view = foes.map(f => ({ id: keyOf(f), seen: true, sunk: !isShip(f) && !!f.sunk })), ctx = { radar: AI_RADAR, contacts: view, missiles: [] };
      if (c.radar.on) for (const f of foes) { if (!isShip(f) && f.sunk) continue; const r = rec(a, f); if (r.tracked && r.known === null && !r.idActive) { if (c.dead) command(c, { type: "identify", id: keyOf(f) }, ctx); else startIdent(r); } }
      identifySweep(c, foes, dt); }
    const hostT = () => Object.keys(a.trk).filter(k => k !== "_" && a.trk[k].tracked && a.trk[k].known === "host").sort((x, y) => a.trk[y].q - a.trk[x].q);
    const rebind = k => { if (String(a.pid) === k) return; const f = foes.find(u => String(keyOf(u)) === k), r = a.trk[k]; a.pid = keyOf(f); P = f; d = D(f); a.dist = d; a.lost = 0; a.brg = norm(Math.atan2(f.x - c.x, f.y - c.y) * 180 / Math.PI); };
    // behaviour: a tracked foe known hostile = engage (hunt it); else any tracked unknown = identify; else a heard emitter = investigate
    if (a.state !== "engage") {
      const H = hostT();
      if (H.length) { rebind(H[0]); a.state = "engage"; a.lost = 0; }
      else if (a.state === "id") { if (!unkT().length) a.state = "patrol"; }
      else if (unkT().length) { const U = unkT(); if (!a.tracks || a.known !== null) rebind(U[0]); a.state = "id"; a.lost = 0; }
      else if (a.state === "inv") { if (a.hears) a.il = 0; else if ((a.il += dt) > A.INV_HOLD) a.state = "patrol"; }
      else if (a.hears && a.known !== "neutral") { a.state = "inv"; a.hb = a.hears.brg; a.il = 0; } // ESM contact without a radar track: go and look
    } else {
      if (!a.tracks) { const H = hostT(); if (H.length) rebind(H[0]); }
      if (a.tracks) a.lost = 0; else a.lost += dt;
      if (a.lost > A.GIVE_UP) a.state = "patrol"; // lost it for too long: back to patrol
    }
    if (a.state === "id" && a.lost > A.GIVE_UP) a.state = "patrol";
    esmSweep(c, c.esmS, foes, dt); // the shared ESM driver; `hears` = the freshest bearing among its foes (what the FSM and the fix code read)
    { let best = null; for (const k in a.trk) { const e = a.trk[k].esm; if (e && (!best || e.t > best.t)) best = e; }
      if (best) { const t = a.t - (c.esmS.t - best.t); if (!a.hears) a.nHear++; if (!a.hears || a.hears.t !== t) a.hb = best.brg; a.hears = { brg: best.brg, t }; } else a.hears = null; }
  }
  // Launch rule (real dt): while engaging, one launch per FIRE_CD seconds at a foe it holds a solid track on (q > FIRE_Q), random pick among solid foes,
  // or at a FIX it knows is hostile. Weapon = random pick among those that reach (ASM only beyond SSM range). The missile goes through the same stepMissiles code as any other.
  function aiFireStep(c, ship, missiles, dt, ally, contacts) {
    const a = c.ai, A = CFG.AI; if (!a) return null;
    a.cd = Math.max(0, a.cd - dt); a.fixCd = Math.max(0, (a.fixCd || 0) - dt);
    if (c.sunk) { c.fire = null; return null; }
    const foes = foesOf(c, ship, ally, contacts); bindPrimary(a, foes);
    // the AI's view of its foes = its own track records (last known positions), in the same shape the fire command reads
    const fx = a.fix && (a.fix.host || a.known === "host") ? a.fix : null;
    const view = foes.map(f => { const r = rec(a, f); return { id: keyOf(f), seen: true, sunk: !!f.sunk, tracked: r.tracked, px: r.px, py: r.py }; });
    if (fx) view.push({ id: "FIX", marker: true, seen: true, tracked: true, px: fx.x, py: fx.y });
    const ctx = { radar: AI_RADAR, contacts: view, missiles };
    if (c.fire) return fireStep(c, view, missiles, dt, ship); // countdown running (aborts itself if the track is lost, out of range, weapons destroyed...)
    if (c.dead && c.dead[2]) return null; // weapons destroyed
    const T = a.state !== "engage" ? [] : view.filter(v => !v.marker && !v.sunk && (r => r.tracked && r.q > A.FIRE_Q && r.known === "host")(a.trk[v.id])).sort((x, y) => (x.id === a.pid) - (y.id === a.pid)); // primary last
    if (a.cd > 0 || (!T.length && (!fx || ship.sunk || a.fixCd > 0))) return null; // blind shots at an ESM fix: one probing shot per FIX_CD
    const tgt = T.length ? (T.length === 1 ? T[0] : T[Math.floor(rand(a) * T.length)]) : view[view.length - 1]; // no solid track = fire at the hostile FIX
    const d = Math.hypot(tgt.px - c.x, tgt.py - c.y);
    const opts = ["ssm", "asm"].filter(k => slotOf(c, k).ammo > 0 && d <= CFG.WEAPONS[k].range); // weapons that can reach the known position
    if (!opts.length) return null;
    const w = opts[Math.floor(rand(a) * opts.length)]; // random mix
    if (!command(c, { type: "fire", slot: c.loadout.indexOf(slotOf(c, w)), id: tgt.id }, ctx).ok) return null;
    a.cd = A.FIRE_CD; if (tgt.marker) a.fixCd = A.FIX_CD; return null; // the missile leaves when the countdown ends (fireStep above)
  }
  // ---- command layer: every action a controller (the human UI now; a network client or the AI later) takes on a unit goes through command(unit, cmd, ctx) -> {ok, msg}.
  // cmd = {type, ...args}. ctx = {radar, contacts (incl. FIX markers), missiles}. The same validator for everyone: the owning station must be alive and, if the unit has `holds` (crew), held by the issuer.
  const AI_RADAR = { on: true }; // AI units are never in player EMCON for jamming/LINK rules (their radar duty cycle is separate)
  const CMD_STN = { set_course: 0, set_speed: 0, emcon: 1, radar: 1, link: 1, identify: 1, cancel_identify: 1, tag: 1, fire: 2, cancel_fire: 2, ecm: 3, deploy_decoy: 3, launch_sam: 3, ciws: 3 }; // index into dead[] / STN
  const STN_LONG = ["NAVIGATION", "SENSORS", "WEAPONS", "DEFENSE"];
  function command(u, cmd, ctx) {
    const R = (ok, msg) => ({ ok, msg: msg || "" }), st = cmd && CMD_STN[cmd.type];
    if (cmd && (cmd.type === "take_station" || cmd.type === "release_station")) { // crew: hold or give up a station (unit.holds unset = all held; solo)
      const i = +cmd.stn; if (!(i >= 0 && i < 4)) return R(false, "Bad station.");
      if (ctx && ctx.pid != null) { // per-player seats (network): u.seats[stn] = ids of the players holding it; several players may share a station
        const s = u.seats || (u.seats = [[], [], [], []]), has = s[i].includes(ctx.pid);
        if (cmd.type === "take_station") { if (u.dead[i]) return R(false, STN_LONG[i] + " destroyed."); if (!has) s[i].push(ctx.pid); } else if (has) s[i] = s[i].filter(p => p !== ctx.pid);
        return R(true); }
      const h = u.holds || (u.holds = [true, true, true, true]);
      if (cmd.type === "take_station") { if (u.dead[i]) return R(false, STN_LONG[i] + " destroyed."); h[i] = true; } else h[i] = false;
      return R(true); }
    if (st === undefined) return R(false, "Unknown command.");
    if (u.dead[st]) return R(false, STN_LONG[st] + " destroyed.");
    if (!(ctx && ctx.pid != null) && u.holds && !u.holds[st]) return R(false, "You do not hold " + STN_LONG[st] + "."); // u.holds = the local (host/solo/AI) issuer's seats; network players are gated by u.seats below
    if (ctx && ctx.pid != null && u.seats && !u.seats[st].includes(ctx.pid)) return R(false, "You do not hold " + STN_LONG[st] + "."); // network issuer: unseated players (and unheld stations) are refused; no seats yet = solo, everything allowed
    const rad = u.radar || ctx.radar, emcon = u.ctl === "human" && !rad.on && !u.dead[1], byId = (list, id) => list.find(k => k.id === id && !k.marker && !k.sunk);
    switch (cmd.type) {
      case "set_course": { const v = +cmd.hdg; if (!isFinite(v)) return R(false, "Bad heading."); u.ordHdg = norm(v); return R(true); }
      case "set_speed": { const v = +cmd.kt; if (!isFinite(v)) return R(false, "Bad speed."); u.ordSpd = v; return R(true); }
      case "radar": rad.on = !!cmd.on; return R(true); // plain radar switch (AI duty cycle): no side effects on ECM / LINK
      case "emcon": rad.on = !cmd.on; if (cmd.on) { u.def.ecm = false; u.link = false; } return R(true); // EMCON on = radar silent; jamming and LINK are emissions, forced off
      case "link": { const m = toggleLink(u, emcon); return R(!/unavailable|destroyed/i.test(m), m); }
      case "identify": { const c = byId(ctx.contacts, cmd.id); if (!c || !c.seen) return R(false, "Select a contact."); return R(startIdent(trkOf(u, c))); }
      case "cancel_identify": { const c = byId(ctx.contacts, cmd.id); if (!c) return R(false); cancelIdentify(trkOf(u, c)); return R(true); }
      case "tag": { const c = byId(ctx.contacts, cmd.id); return R(!!c && setTag(c.marker ? c : trkOf(u, c), cmd.cls)); }
      case "fire": { const c = ctx.contacts.find(k => k.id === cmd.id && k.seen && !k.sunk), why = fireCheck(u, cmd.slot, c); if (why) return R(false, why); return R(startFire(u, cmd.slot, c)); }
      case "cancel_fire": cancelFire(u); return R(true);
      case "ecm": { if (cmd.on !== undefined && !!u.def.ecm === !!cmd.on) return R(true); const m = toggleEcm(u, emcon); return R(!/unavailable/.test(m), m); } // on: true/false = set instead of toggle
      case "deploy_decoy": { const m = deployDecoy(u, ctx.missiles, ctx.mine); return R(/^Decoy deployed/.test(m), m); }
      case "launch_sam": { const m = launchSam(u, ctx.missiles, cmd.uid, ctx.mine); return R(m === "SAM launched.", m); }
      case "ciws": setCiws(u, cmd.uid == null ? null : cmd.uid); return R(true);
    }
  }
  // ---- crew + filtered view (network prerequisites) ----
  function dropPlayer(u, pid) { if (u.seats) u.seats = u.seats.map(s => s.filter(p => p !== pid)); } // a disconnected player gives up every seat
  const seatsOf = (u, pid) => [0, 1, 2, 3].map(i => !u.seats || u.seats[i].includes(pid)); // which stations player pid may use on unit u (no seats yet = all)
  // viewFor(units, missiles, viewer, pid): the ONLY data a client receives (plain JSON, never ground truth): own ship state, the viewer's own track table
  // (last detected positions, no real positions, RCS or hidden side), the viewer's FIX markers, and the missiles it may know about
  // (own team's always; others only if aimed at the viewer or inside the radar horizon).
  function viewFor(units, missiles, v, pid) {
    const r1 = n => Math.round(n * 100) / 100, me = isShip(v) ? "own" : v.id, T = v.ai ? v.ai.trk : (v.trk || {}), byKey = {};
    for (const u of units) byKey[keyOf(u)] = u;
    const tracks = [], fr = v.link && !(v.dead && v.dead[1]) ? units.find(u => u !== v && u.team === v.team && u.esmS && !(u.dead && u.dead[1])) : null, FT = fr ? (fr.ai ? fr.ai.trk : fr.trk) : null; // fr = the friend whose ESM bearings LINK shares
    for (const k of Object.keys(T)) { const r = T[k], f = byKey[k]; if (k === "_" || !(r.seen || r.esm) || !f || (f.sunk && !isShip(f) && !r.seen)) continue;
      const dx = r.px - v.x, dy = r.py - v.y; // from the last DETECTED position
      tracks.push({ id: k, seen: !!r.seen, esmNo: r.esmNo, tracked: r.tracked, q: r1(r.q), brg: r1(norm(Math.atan2(dx, dy) * 180 / Math.PI)), rng: r1(Math.hypot(dx, dy)), px: r1(r.px), py: r1(r.py), cls: r.cls, identified: r.identified, idActive: r.idActive, idProg: r1(r.idProg), idNote: r.idNote, esm: r.esm ? { brg: r1(r.esm.brg), t: r.esm.t } : null,
        sunk: !!f.sunk, lastHit: r1(r.lastHit), hdg: r.identified ? r1(f.hdg || 0) : null, emit: f.emit ? f.emit.name : null, idT: r.seen ? r1(identTime(v, f)) : 0, esmA: FT && FT[k] && FT[k].esm ? { brg: r1(FT[k].esm.brg), t: r1(FT[k].esm.t) } : null }); } // hdg only once identified (the scope draws that line); esmA = the friend's bearing (white line)
    const ms = [];
    for (const m of missiles) { const atMe = m.tid === me, mine = (m.side === "enemy") === (v.team === "red"); // m.side is relative to the player ship: own/ally = blue team, enemy = red team
      if (!(mine || atMe || Math.hypot(m.x - v.x, m.y - v.y) <= CFG.RADAR.HORIZON)) continue;
      ms.push({ uid: m.uid, n: m.n, lbl: m.lbl || null, side: m.side, w: m.w, x: r1(m.x), y: r1(m.y), hdg: r1(m.hdg), spd: m.spd, state: m.state || null, atMe, tid: mine ? m.tid : null, tx: mine && m.tx !== undefined ? r1(m.tx) : null, ty: mine && m.ty !== undefined ? r1(m.ty) : null }); }
    const friends = [], sams = [];
    for (const u of units) { if (u === v) continue; const mine = u.team === v.team;
      if (mine) friends.push({ id: keyOf(u), x: r1(u.x), y: r1(u.y), hdg: r1(u.hdg), sunk: !!u.sunk, wreck: !!u.wreck });
      for (const q of (u.def && u.def.sams) || []) { if (!mine && Math.hypot(q.x - v.x, q.y - v.y) > CFG.RADAR.HORIZON) continue; sams.push({ x: r1(q.x), y: r1(q.y), hdg: r1(q.hdg || 0), mine }); } }
    for (const q of v.def.sams || []) sams.push({ x: r1(q.x), y: r1(q.y), hdg: r1(q.hdg || 0), mine: true, own: true, uid: q.uid });
    return { id: me, team: v.team, friends, sams, own: { x: r1(v.x), y: r1(v.y), hdg: r1(v.hdg), spd: r1(v.spd), ordHdg: r1(v.ordHdg || 0), ordSpd: v.ordSpd || 0, dead: v.dead.slice(), sunk: v.sunk, wreck: v.wreck, holds: pid != null ? seatsOf(v, pid) : (v.holds ? v.holds.slice() : [true, true, true, true]), radarOn: !!(v.radar && v.radar.on), ecm: !!v.def.ecm, link: !!v.link,
      loadout: v.loadout.map(l => ({ w: l.w, ammo: l.ammo })), def: { decoy: v.def.decoy, sam: v.def.sam, cd: r1(v.def.cd), samCd: r1(v.def.samCd), ciws: v.def.ciws, ciwsOn: v.def.ciwsOn }, fire: v.fire ? { slot: v.fire.slot, tid: v.fire.tid, t: r1(v.fire.t) } : null, fireMsg: v.fireMsg || "", hitMsg: v.hitMsg || "", hitSeq: v.hitSeq || 0, strikeMsg: v.strikeMsg || "", strikeSeq: v.strikeSeq || 0,
      radar: { ang: r1((v.radar && v.radar.ang) || 0), t: r1((v.radar && v.radar.t) || 0) }, esmT: r1(v.esmS ? v.esmS.t : 0), allyEsmT: fr ? r1(fr.esmS.t) : 0 },
      tracks, fixes: (v.fixes || []).map(f => ({ id: f.id, emId: f.emId, esmNo: f.esmNo, px: r1(f.px), py: r1(f.py), t: r1(f.t) })), missiles: ms };
  }
  // ---- command queue (network): clients send {t:"cmd", seq, type, args}; the host enqueues them and drains once per tick, in arrival order ----
  // Each player's seq must increase; a repeated/older seq is a retransmit: acked again, NOT executed twice. Replies: {t:"ack",seq[,dup]} or {t:"err",seq,msg}.
  const newInbox = () => ({ q: [], last: {} });
  const enqueue = (inbox, pid, msg) => { inbox.q.push({ pid, msg }); };
  function drain(inbox, unitOf, ctx) { // unitOf(pid) -> the unit that player controls (or null); returns [{pid, reply}]
    const out = [], items = inbox.q; inbox.q = [];
    for (const { pid, msg } of items) {
      const seq = msg && msg.seq, bad = m => out.push({ pid, reply: { t: "err", seq: seq === undefined ? null : seq, msg: m } });
      if (!msg || msg.t !== "cmd" || !Number.isInteger(seq) || seq < 1) { bad("Bad command message."); continue; }
      if (seq <= (inbox.last[pid] || 0)) { out.push({ pid, reply: { t: "ack", seq, dup: true } }); continue; }
      inbox.last[pid] = seq; // consumed even if refused, so a retransmit of a refused command is not retried
      const u = unitOf(pid); if (!u) { bad("No unit."); continue; }
      if (typeof msg.type !== "string") { bad("Bad command message."); continue; }
      const r = command(u, Object.assign({}, msg.args && typeof msg.args === "object" ? msg.args : {}, { type: msg.type }), Object.assign({}, ctx, { pid }));
      out.push({ pid, reply: r.ok ? (r.msg ? { t: "ack", seq, msg: r.msg } : { t: "ack", seq }) : { t: "err", seq, msg: r.msg || "Refused." } }); } // ack may carry the command's message (e.g. LINK / SAM / decoy result)
    return out;
  }
  const api = { newInbox, enqueue, drain, dropPlayer, seatsOf, viewFor, linkShare, command, trkOf, reloadStep, newTrk, toggleLink, newAlly, resetAlly, allyStep, stepUnit, launchMissile, rays, fixStep, aiFixStep, initEnemy, resetEnemy, aiDefStep, aiSamMove, allyDefStep, allySamMove, resetAi, aiIdTime, aiFireStep, newAi, aiStep, ciwsStep, ecmStep, toggleEcm, deployDecoy, launchSam, setCiws, stepDefense, reap, defCheck, CFG, norm, diff, newShip, step, newRadar, newContact, pDetect, radarStep, setTag, stepContact, newEsm, pEsm, esmStep, startIdentify, cancelIdentify, identifyStep, identifyTime, fireCheck, startFire, cancelFire, fireStep, stepMissiles, hitShip, debugMissile, resetShip, STN };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sim = api;
})(typeof self !== "undefined" ? self : this);
