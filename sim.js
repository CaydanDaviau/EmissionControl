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
    ESM: { H_ANT: 100, RANGE_FACTOR: 2, DUCT: 1.3, INTERVAL: 2, SIGMA: 5, HOLD: 15 },
    // Identify: needs a continuous radar track (real time, like all sensors). Takes longer at long range and for low-RCS (stealthy) contacts. Track lost = reset to 0.
    // Weapons (game data; per-ship loadouts later). range nm, speed kt, turn deg/s
    WEAPONS: { ssm: { name: "SSM", model: "RGM-84", range: 70, speed: 480, turn: 10, dmg: "SSM" },
      asm: { name: "ASM", model: "LRASM", range: 150, speed: 500, turn: 8, dmg: "ASM" } },
    // Damage is per station (index 0..3 = NAVIGATION, SENSORS, WEAPONS, DEFENSE). second = chance a hit destroys a 2nd station; nav = can hit NAVIGATION.
    // Ship is destroyed when 1 or fewer stations are left. Destroyed ship decelerates by DRIFT_DECEL (kt/s), then stays as a wreck.
    DAMAGE: { P_HIT: 0.9, DRIFT_DECEL: 1, DEBUG_DIST: 20, SSM: { second: 0.15, nav: false }, ASM: { second: 0.55, nav: true } },
    // Defense (game data, tunable). Decoy: small chance per deploy to seduce each incoming missile (it then flies straight on, unguided). CIWS: fixed chance per second on ONE missile inside its range.
    // SAM: long range, highest kill chance, limited ammo; resolves after flight time. Dead missiles stay as a white X for X_TIME real seconds.
    DEFENSE: { ECM: { NAME: "AN/SLQ-32", RANGE: 20, P: 0.03, EMIT: 40 }, DECOY: { P: 0.2, AMMO: 4, CD: 20, RANGE: 4 }, CIWS: { RANGE: 1, P: 0.1 }, SAM: { RANGE: 25, P: 0.35, AMMO: 16, SPEED: 2000 }, X_TIME: 10, STRAY: 60 },
    LINK: { EMIT: 25 }, FIX: { LIFE: 5, FRESH: 2.5, MIN_SIN: 0.05, MAXR: 120 }, ALLY: { OFFSET: 15 }, // LINK emits (enemy ESM hears it); FIX = marker where two ESM bearing lines cross: lives LIFE s, bearings count as fresh for FRESH s, lines must cross at > MIN_SIN and < MAXR nm; ALLY = formation slot nm abeam (starboard)
    WEAPON: { COUNTDOWN: 5, ARRIVE: 0.5, SEEKER: 5 }, // SEEKER = nm: a missile reaching the last known position hits only if the target is truly within this; // launch countdown (s, real time); arrive radius (nm)
    AI: { DUTY_PERIOD: 60, DUTY_ON: 20, SWEEP: 4, SHIP_RCS: 10000, SHIP_H: 60, H_ANT: 100, COAST: 0.02, TURN: 3, WP_NM: 1, FIRE_Q: 0.5, FIRE_CD: 30, HOLD: 0.8, BAND: 4, GIVE_UP: 180, REACT_MIN: 2, REACT_MAX: 5, INV_HOLD: 60 }, // HOLD = fraction of its radar range it tries to keep us at (detection edge), BAND = +- nm around that, GIVE_UP = real s without a track before it goes back to patrol; // enemy radar on 20 s of every 60 s; FIRE_Q = min track quality to fire, FIRE_CD = seconds between launches
    IDENTIFY: { TIME: 20, D_REF: 10, MIN: 5, MAX: 90 } // TIME = seconds at D_REF nm for a normal (RCS_REF) contact
  };
  const STN = ["NAVIGATION", "SENSORS", "WEAPONS", "DEFENSE"];
  const norm = a => ((a % 360) + 360) % 360;
  const diff = (to, from) => { const d = norm(to - from); return d > 180 ? d - 360 : d; };

  function newShip() { return { rel: "host", x: 0, y: 0, hdg: 0, spd: 0, ordHdg: 0, ordSpd: 0,
    loadout: [{ w: "ssm", ammo: 8 }, { w: "asm", ammo: 4 }], fire: null, fireMsg: "", nMsl: 0,
    dead: [false, false, false, false], sunk: false, wreck: false, rng: { seed: 20261113 }, nEnemy: 0, hitSeq: 0, hitMsg: "", uid: 0,
    def: { decoy: CFG.DEFENSE.DECOY.AMMO, sam: CFG.DEFENSE.SAM.AMMO, cd: 0, ciws: null, ciwsOn: null, ecm: false }, sams: [] }; } // ciws = manual target uid (null = auto), ciwsOn = uid being engaged now; sams = pending intercepts // x east nm, y north nm

  function step(s, dt) {
    if (s.wreck) return;
    const ds = s.ordSpd - s.spd, ma = (s.sunk ? CFG.DAMAGE.DRIFT_DECEL : CFG.ACCEL) * dt;
    s.spd = Math.abs(ds) <= ma ? s.ordSpd : s.spd + Math.sign(ds) * ma;
    const f = Math.max(CFG.TURN_MIN, Math.min(1, Math.abs(s.spd) / CFG.TURN_FULL_AT));
    const dh = diff(s.ordHdg, s.hdg), mt = CFG.TURN * f * dt;
    s.hdg = norm(Math.abs(dh) <= mt ? s.ordHdg : s.hdg + Math.sign(dh) * mt);
    const r = s.hdg * Math.PI / 180, d = s.spd * dt / 3600;
    s.x += Math.sin(r) * d; s.y += Math.cos(r) * d;
    if (s.sunk && s.spd === 0) s.wreck = true; // stopped: permanent wreck
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
    const R = CFG.RADAR; if (d > R.HORIZON) return 0; // flat horizon cap (nm), then RCS and range
    const rd = R.RANGE * Math.pow(c.rcs / R.RCS_REF, 0.25);
    return 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd)));
  }
  function radarStep(r, ship, contacts, dt) {
    const inc = 360 / CFG.RADAR.PERIOD * dt, a0 = r.ang;
    r.ang = norm(a0 + inc); r.t += dt;
    for (const c of contacts) {
      if (c.sunk) { c.tracked = false; c.q = 0; c.idActive = false; continue; } // destroyed: no longer tracked
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
  function steer(c, want, dt) { const dh = diff(want, c.hdg), mt = CFG.AI.TURN * dt; c.hdg = norm(Math.abs(dh) <= mt ? want : c.hdg + Math.sign(dh) * mt); }
  function stepContact(c, dt) {
    const a = c.ai;
    if (c.sunk) { c.spd = Math.max(0, c.spd - CFG.DAMAGE.DRIFT_DECEL * dt); if (!c.spd) c.wreck = true; } // destroyed: decelerates, no steering, then a wreck
    else if (c.dead && c.dead[0]) { /* NAVIGATION destroyed: holds last course and speed */ }
    else if (a && a.state === "inv") { steer(c, a.hb, dt); c.spd = CFG.FLANK; } // investigating: flank along the ESM bearing (no range known)
    else if (a && a.state && a.state !== "patrol") { // hunting (id / engage): close in at flank, then hold at the edge of its detection (HOLD x radar range); too close = open range, inside the band = circle
      const dx = a.lx - c.x, dy = a.ly - c.y, d = Math.hypot(dx, dy), hold = CFG.AI.HOLD * c.emit.range, to = norm(Math.atan2(dx, dy) * 180 / Math.PI);
      let want = to, spd = CFG.FLANK;
      if (a.tracks) { if (d < hold - CFG.AI.BAND) { want = norm(to + 180); spd = CFG.CRUISE; } else if (d <= hold + CFG.AI.BAND) { want = norm(to + 90); spd = CFG.CRUISE; } }
      else if (d < 1) { want = c.hdg; spd = CFG.CRUISE; } // reached the last known position, nothing there
      steer(c, want, dt); c.spd = spd;
    } else if (a && a.wp) { // patrol: steer to the next waypoint (loop), same turn rate as ships
      const w = a.wp[a.i], dx = w[0] - c.x, dy = w[1] - c.y;
      if (Math.hypot(dx, dy) < CFG.AI.WP_NM) a.i = (a.i + 1) % a.wp.length;
      steer(c, norm(Math.atan2(dx, dy) * 180 / Math.PI), dt); c.spd = CFG.CRUISE;
    }
    if (!c.spd) return;
    const r = c.hdg * Math.PI / 180, d = c.spd * dt / 3600;
    c.x += Math.sin(r) * d; c.y += Math.cos(r) * d;
  }
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
  function esmStep(e, ship, contacts, dt, key) { // key = where the bearing is stored on the contact: "esm" (own ship) or "esmA" (ally, via LINK)
    key = key || "esm"; const E = CFG.ESM; e.t += dt; e.acc += dt;
    while (e.acc >= E.INTERVAL) {
      e.acc -= E.INTERVAL;
      for (const c of contacts) {
        if (!c.emit) continue;
        const dx = c.x - ship.x, dy = c.y - ship.y;
        if (c.emitting && rand(e) < pEsm(Math.hypot(dx, dy), c)) {
          const b = norm(Math.atan2(dx, dy) * 180 / Math.PI + gauss(e) * E.SIGMA);
          if (!c.esmNo && key === "esm") c.esmNo = ++e.n;
          c[key] = { brg: c[key] ? norm(c[key].brg + 0.4 * diff(b, c[key].brg)) : b, t: e.t }; // light smoothing
        }
        if (c[key] && e.t - c[key].t > E.HOLD) c[key] = null;
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
  function fireStep(ship, contacts, missiles, dt) { // real-time dt, once per frame
    const f = ship.fire; if (!f) return;
    const c = contacts.find(k => k.id === f.tid) || f.mk, why = fireCheck(ship, f.slot, c);
    if (why) { ship.fire = null; ship.fireMsg = "Launch aborted: " + why; return; } // track lost, out of range...
    f.t -= dt; if (f.t > 0) return;
    const L = ship.loadout[f.slot], W = CFG.WEAPONS[L.w];
    L.ammo--; ship.fire = null; ship.fireMsg = "";
    const nm = { uid: ++ship.uid, n: ++ship.nMsl, side: "own", w: L.w, tid: c.id, x: ship.x, y: ship.y, hdg: ship.hdg, spd: W.speed, fuel: W.range };
    if (c.marker) { nm.tid = "mk"; nm.tx = c.px; nm.ty = c.py; } // FIX marker: flies to that fixed point, its seeker looks for a ship there
    missiles.push(nm);
    if (c.ai && !c.sunk) aiProvoke(c, ship);
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
  function resetShip(ship) { ship.def = { decoy: CFG.DEFENSE.DECOY.AMMO, sam: CFG.DEFENSE.SAM.AMMO, cd: 0, ciws: null, ciwsOn: null, ecm: false }; ship.sams = [];
    ship.dead = [false, false, false, false]; ship.link = false; ship.sunk = false; ship.wreck = false; ship.fire = null; ship.fireMsg = ""; ship.hitMsg = ""; }
  function stepMissiles(missiles, contacts, dt, ship) { // scaled dt. tid "own" = aimed at the own ship (true position). Others: last known position, no damage yet
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i], W = CFG.WEAPONS[m.w], own = m.tid === "own";
      if (m.state === "dead") continue;                                   // destroyed: frozen, removed by reap()
      if (m.state === "decoy" || m.state === "jam") {                                         // seduced: flies straight, no guidance, no hit
        const d = m.spd * dt / 3600, r = m.hdg * Math.PI / 180; m.x += Math.sin(r) * d; m.y += Math.cos(r) * d; m.fuel -= d;
        if (m.fuel <= 0 || Math.hypot(m.x - ship.x, m.y - ship.y) > CFG.DEFENSE.STRAY) missiles.splice(i, 1);
        continue; }
      const fixed = m.tid === "mk", c = own || fixed ? null : contacts.find(k => k.id === m.tid);
      let tr = c && m.side === "enemy" ? { x: c.x, y: c.y } : c ? { x: c.px, y: c.py } : null; // enemy missiles at allies use true position
      if (own) { if (m.tx !== undefined && Math.hypot(ship.x - m.x, ship.y - m.y) <= CFG.WEAPON.SEEKER) m.tx = undefined; // aimed at a fix: seeker acquires the ship once close enough
        tr = m.tx !== undefined ? { x: m.tx, y: m.ty } : { x: ship.x, y: ship.y }; }
      else if (fixed) tr = { x: m.tx, y: m.ty };
      if (!tr) { missiles.splice(i, 1); continue; }
      if (c && c.sunk && m.side === "own") { missiles.splice(i, 1); continue; } // target already destroyed
      const dx = tr.x - m.x, dy = tr.y - m.y;
      if (Math.hypot(dx, dy) < CFG.WEAPON.ARRIVE) {
        if (own) { if (m.tx !== undefined) { ship.hitSeq++; ship.hitMsg = (m.lbl || "M" + m.n) + " MISSED"; } // reached the fix without finding us
          else { const r = hitShip(ship, W.dmg); ship.hitSeq++;
            ship.hitMsg = (m.lbl || "M" + m.n) + (!r.hit ? " MISSED" : r.sunk ? " HIT: SHIP DESTROYED" : " HIT: " + r.lost.map(k => STN[k]).join(" + ") + " DESTROYED"); } }
        else if (m.side === "own" && (fixed || (c && c.dead))) { // our missile reaches its aim point (last known position / FIX): hits only a ship really within the seeker radius
          const dd = k => Math.hypot(k.x - m.x, k.y - m.y), v = fixed ? contacts.filter(k => k.dead && !k.sunk && dd(k) <= CFG.WEAPON.SEEKER).sort((a, b) => dd(a) - dd(b))[0] : (dd(c) <= CFG.WEAPON.SEEKER ? c : null);
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
  function deployDecoy(ship, missiles) { // returns message. Each incoming missile aimed at us rolls P; success = decoyed
    const D = CFG.DEFENSE.DECOY, df = ship.def, why = defCheck(ship);
    if (why) return why; if (df.decoy <= 0) return "No decoys left."; if (df.cd > 0) return "Decoy reloading: " + Math.ceil(df.cd) + " s.";
    df.decoy--; df.cd = D.CD; let n = 0, near = 0;
    for (const m of missiles) if (live(m) && m.tid === "own" && mdist(ship, m) <= D.RANGE) { near++; if (rand(ship.rng) < D.P) { seduce(ship, m, "decoy"); n++; } } // only missiles inside RANGE can be seduced
    return n ? "Decoy deployed: " + n + " missile(s) seduced." : near ? "Decoy deployed: no effect." : "Decoy deployed: no missile within " + D.RANGE + " NM.";
  }
  function launchSam(ship, missiles, uid) {
    const S = CFG.DEFENSE.SAM, m = missiles.find(k => k.uid === uid), why = defCheck(ship);
    if (why) return why; if (!m || !live(m)) return "Select a live incoming missile."; if (ship.def.sam <= 0) return "No SAM ammo.";
    const d = mdist(ship, m); if (d > S.RANGE) return "Out of SAM range: " + d.toFixed(1) + " / " + S.RANGE + " NM.";
    ship.def.sam--; ship.sams.push({ uid, x: ship.x, y: ship.y, hdg: norm(Math.atan2(m.x - ship.x, m.y - ship.y) * 180 / Math.PI) }); return "SAM launched.";
  }
  function setCiws(ship, uid) { ship.def.ciws = uid == null ? null : uid; } // manual target (even out of range) disables auto
  function stepDefense(ship, missiles, dt) { // SCALED dt: only SAM flight speed (time button affects speeds only)
    const df = ship.def, S = CFG.DEFENSE;
    if (ship.dead[3]) { df.ciwsOn = null; df.ecm = false; ship.sams.length = 0; return; }
    for (let i = ship.sams.length - 1; i >= 0; i--) { const q = ship.sams[i], m = missiles.find(k => k.uid === q.uid); // SAM flies straight at its target
      if (!m || !live(m)) { ship.sams.splice(i, 1); continue; }
      const dx = m.x - q.x, dy = m.y - q.y, dd = Math.hypot(dx, dy), mv = S.SAM.SPEED * dt / 3600; q.hdg = norm(Math.atan2(dx, dy) * 180 / Math.PI);
      if (dd <= mv + 0.3) { ship.sams.splice(i, 1); if (rand(ship.rng) < S.SAM.P) { m.state = "dead"; m.dieT = S.X_TIME; } continue; }
      q.x += dx / dd * mv; q.y += dy / dd * mv; }
  }
  function ciwsStep(ship, missiles, dt) { // REAL dt: decoy reload and CIWS rolls are not sped up by the time button
    const df = ship.def, S = CFG.DEFENSE; df.cd = Math.max(0, df.cd - dt);
    if (ship.dead[3]) { df.ciwsOn = null; return; }
    let tg = null;
    if (df.ciws != null) { tg = missiles.find(k => k.uid === df.ciws && live(k)); if (!tg) df.ciws = null; } // manual target gone: back to auto
    if (df.ciws == null) { let bd = 1e9; for (const m of missiles) if (live(m)) { const d = mdist(ship, m); if (d <= S.CIWS.RANGE && d < bd) { bd = d; tg = m; } } }
    df.ciwsOn = null;
    if (tg && mdist(ship, tg) <= S.CIWS.RANGE) { df.ciwsOn = tg.uid; if (rand(ship.rng) < 1 - Math.pow(1 - S.CIWS.P, dt)) { tg.state = "dead"; tg.dieT = S.X_TIME; } }
  }
  function ecmStep(ship, missiles, dt) { // REAL-time dt (not the Time button): jamming chance per real second
    const S = CFG.DEFENSE; if (!ship.def.ecm || ship.dead[3]) return;
    for (const m of missiles) if (live(m) && m.tid === "own" && mdist(ship, m) <= S.ECM.RANGE && rand(ship.rng) < 1 - Math.pow(1 - S.ECM.P, dt)) seduce(ship, m, "jam");
  }
  function reap(missiles, dt) { for (let i = missiles.length - 1; i >= 0; i--) { const m = missiles[i]; if (m.state === "dead" && (m.dieT -= dt) <= 0) missiles.splice(i, 1); } } // real dt
  // ---- LINK, ally, ESM fixes ----
  function toggleLink(ship, emcon) { if (ship.dead[1]) return "Sensors destroyed."; if (emcon) { ship.link = false; return "EMCON active: LINK unavailable."; } ship.link = !ship.link; return "LINK " + (ship.link ? "ON." : "OFF."); } // LINK is an emission: off under EMCON
  function newAlly(x, y) { return { id: "A1", x, y, hdg: 0, spd: 0 }; }
  function allyStep(al, ship, dt) { // SCALED dt: holds a slot CFG.ALLY.OFFSET nm abeam (starboard) of our ship
    const r = (ship.hdg + 90) * Math.PI / 180, dx = ship.x + Math.sin(r) * CFG.ALLY.OFFSET - al.x, dy = ship.y + Math.cos(r) * CFG.ALLY.OFFSET - al.y, d = Math.hypot(dx, dy);
    if (d < 0.2) { al.hdg = ship.hdg; al.spd = ship.spd; } else { steer(al, norm(Math.atan2(dx, dy) * 180 / Math.PI), dt); al.spd = Math.min(CFG.FLANK, Math.max(0, ship.spd) + 20 * d); }
    const q = al.hdg * Math.PI / 180, k = al.spd * dt / 3600; al.x += Math.sin(q) * k; al.y += Math.cos(q) * k;
  }
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
  function initEnemy(c, seed) { c.rng = { seed: seed | 0 }; c.dead = [false, false, false, false]; c.sunk = false; c.wreck = false; c.ecm = false;
    c.def = { decoy: CFG.DEFENSE.DECOY.AMMO, sam: CFG.DEFENSE.SAM.AMMO, cd: 0, sams: [] }; }
  function resetEnemy(c) { initEnemy(c, c.rng ? c.rng.seed : 1); if (c.ai) resetAi(c.ai); }
  function aiDefStep(c, missiles, dt) { // REAL dt: reaction delay, decoy reload, ECM and CIWS rolls
    const df = c.def, A = CFG.AI, S = CFG.DEFENSE; if (!df) return;
    df.cd = Math.max(0, df.cd - dt); c.ecm = false;
    if (c.sunk || c.dead[3]) { df.sams.length = 0; return; }
    const th = []; // our missiles aimed at it, inside SAM range, after its 2-5 s reaction delay
    for (const m of missiles) { if (m.side !== "own" || m.state || m.tid !== c.id) continue;
      const d = Math.hypot(m.x - c.x, m.y - c.y); if (d > S.SAM.RANGE) continue;
      if (m.aiT === undefined) m.aiT = A.REACT_MIN + rand(c.rng) * (A.REACT_MAX - A.REACT_MIN);
      if (m.aiT > 0) { m.aiT -= dt; continue; }
      th.push({ m, d }); }
    th.sort((a, b) => (b.m.w === "asm") - (a.m.w === "asm") || a.d - b.d);
    for (const { m } of th) if (!df.sams.some(q => q.uid === m.uid) && df.sam > 0) { df.sam--; df.sams.push({ uid: m.uid, x: c.x, y: c.y }); } // SAMs: ASMs first (sorted), then SSMs while ammo lasts
    const ssm = th.filter(k => k.m.w === "ssm");
    if (df.cd <= 0 && df.decoy > 0 && ssm.some(k => !k.m.state && k.d <= S.DECOY.RANGE)) { df.decoy--; df.cd = S.DECOY.CD; for (const k of ssm) if (!k.m.state && k.d <= S.DECOY.RANGE && rand(c.rng) < S.DECOY.P) seduce(c, k.m, "decoy"); }
    const jm = ssm.filter(k => !k.m.state && k.d <= S.ECM.RANGE);
    if (jm.length) { c.ecm = true; for (const k of jm) if (rand(c.rng) < 1 - Math.pow(1 - S.ECM.P, dt)) seduce(c, k.m, "jam"); }
    const cw = ssm.filter(k => !k.m.state && k.d <= S.CIWS.RANGE).sort((a, b) => a.d - b.d)[0];
    if (cw && rand(c.rng) < 1 - Math.pow(1 - S.CIWS.P, dt)) { cw.m.state = "dead"; cw.m.dieT = S.X_TIME; }
  }
  function aiSamMove(c, missiles, dt) { // SCALED dt: enemy SAM flight and hit roll
    const df = c.def, S = CFG.DEFENSE; if (!df) return;
    if (c.sunk || c.dead[3]) { df.sams.length = 0; return; }
    for (let i = df.sams.length - 1; i >= 0; i--) { const q = df.sams[i], m = missiles.find(k => k.uid === q.uid);
      if (!m || m.state) { df.sams.splice(i, 1); continue; }
      const dx = m.x - q.x, dy = m.y - q.y, dd = Math.hypot(dx, dy), mv = S.SAM.SPEED * dt / 3600;
      if (dd <= mv + 0.3) { df.sams.splice(i, 1); if (rand(c.rng) < S.SAM.P) { m.state = "dead"; m.dieT = S.X_TIME; } continue; }
      q.x += dx / dd * mv; q.y += dy / dd * mv; }
  }
  // ---- enemy AI (first stage): patrol, duty-cycled radar, ESM; same sensor rules as the player, no weapons yet. Real-time dt ----
  function newAi(seed, wp) { return { seed: seed | 0, wp, i: 0, t: 0, sw: 0, es: 0, q: 0, tracks: false, hears: null, nHear: 0, cd: 0, ammo: { ssm: 8, asm: 4 }, state: "patrol", known: null, idp: 0, lost: 0, lx: 0, ly: 0, hb: 0, il: 0 }; } // state: patrol | inv (investigating an ESM bearing hb; il = real s since last heard) | id | engage; known: null | "host" | "neutral" (its identification of us); idp: identify progress 0..1; lx/ly: last detected position of us
  function aiIdTime(d) { const I = CFG.IDENTIFY; return Math.max(I.MIN, Math.min(I.MAX, I.TIME * (0.6 + 0.4 * d / I.D_REF) * Math.pow(CFG.RADAR.RCS_REF / CFG.AI.SHIP_RCS, 0.25))); } // same formula as ours
  function resetAi(a) { a.state = "patrol"; a.known = null; a.idp = 0; a.lost = 0; a.hb = 0; a.il = 0; a.hears = null; a.fix = null; a.tracks = false; a.q = 0; a.cd = 0; a.ammo = { ssm: 8, asm: 4 }; }
  function aiStep(c, ship, radarOn, dt) {
    const a = c.ai, A = CFG.AI; if (!a) return;
    a.t += dt; a.sw += dt; a.es += dt;
    if (c.sunk || (c.dead && c.dead[1])) { c.emitting = false; a.tracks = false; a.q = 0; a.hears = null; if (a.state !== "patrol") { a.lost += dt; if (a.lost > A.GIVE_UP) { a.state = "patrol"; a.idp = 0; } } return; } // sensors destroyed: no radar, no ESM
    c.emitting = (a.state === "id" && a.tracks) || (a.t % A.DUTY_PERIOD) < A.DUTY_ON; // 20/60 duty cycle always (also in combat); exception: while identifying an unknown it holds a track, radar stays ON until identified or the contact is lost

    const dx = ship.x - c.x, dy = ship.y - c.y, d = Math.hypot(dx, dy);
    if (c.emitting) { // radar: one roll per sweep period, same model as ours
      while (a.sw >= A.SWEEP) { a.sw -= A.SWEEP;
        const rd = c.emit.range * Math.pow(A.SHIP_RCS / CFG.RADAR.RCS_REF, 0.25); // no horizon cap (same rule as our radar): range comes from cross section only
        const p = d > CFG.RADAR.HORIZON ? 0 : 1 / (1 + Math.exp(-(rd - d) / (0.15 * rd))); // same horizon cap as ours
        if (rand(a) < p) { a.q += (1 - a.q) * CFG.RADAR.Q_HIT; a.tracks = true; a.lx = ship.x; a.ly = ship.y; a.dist = d; a.brg = norm(Math.atan2(dx, dy) * 180 / Math.PI); }
        else if (a.tracks) { a.q -= CFG.RADAR.Q_MISS; }
      }
    } else { a.sw = 0; if (a.tracks) a.q -= A.COAST * dt; } // silent: track coasts and decays
    if (a.tracks && a.q < CFG.RADAR.Q_DROP) { a.tracks = false; a.q = 0; }
    // behaviour: a radar track starts identification (hostile known = engage at once; neutral known = ignore). Same rules as ours: needs a continuous track, losing it resets progress.
    if (a.state === "patrol") {
      if (a.tracks && a.known !== "neutral") { a.state = a.known === "host" ? "engage" : "id"; a.idp = 0; a.lost = 0; }
      else if (a.hears && a.known !== "neutral") { a.state = "inv"; a.hb = a.hears.brg; a.il = 0; } // ESM contact without a radar track: go and look
    } else if (a.state === "inv") { // heads along the last ESM bearing; a radar track starts identification, EMCON (no more ESM) makes it give up after INV_HOLD
      if (a.tracks) { a.state = a.known === "host" ? "engage" : "id"; a.idp = 0; a.lost = 0; }
      else if (a.hears) a.il = 0; else if ((a.il += dt) > A.INV_HOLD) a.state = "patrol";
    } else {
      if (a.tracks) a.lost = 0; else a.lost += dt;
      if (a.state === "id") {
        if (!a.tracks) a.idp = 0;
        else if (c.emitting) { a.idp += dt / aiIdTime(d); if (a.idp >= 1) { a.idp = 0; a.known = ship.rel; a.state = a.known === "host" ? "engage" : "patrol"; } }
      }
      if (a.lost > A.GIVE_UP) { a.state = "patrol"; a.idp = 0; } // lost it for too long: back to patrol
    }
    while (a.es >= CFG.ESM.INTERVAL) { a.es -= CFG.ESM.INTERVAL; // ESM: hears our radar, bearing only
      const er = Math.max(radarOn && !ship.dead[1] ? CFG.RADAR.RANGE : 0, ship.def.ecm && !ship.dead[3] ? CFG.DEFENSE.ECM.EMIT : 0, ship.link && !ship.dead[1] ? CFG.LINK.EMIT : 0); // our emissions: radar, jamming, LINK
      if (er > 0 && rand(a) < pEsm(d, { emit: { range: er }, emitting: true, h: A.SHIP_H })) {
        if (!a.hears) a.nHear++; a.hears = { brg: norm(Math.atan2(dx, dy) * 180 / Math.PI + gauss(a) * CFG.ESM.SIGMA), t: a.t }; a.hb = a.hears.brg;
      }
    }
    if (a.hears && a.t - a.hears.t > CFG.ESM.HOLD) a.hears = null;
  }
  // Enemy launch rule (real dt): needs a track on us above FIRE_Q, one launch per FIRE_CD seconds.
  // Weapon is a random pick among those that can reach us (ASM only beyond SSM range). The missile goes through the same stepMissiles code as any other.
  function aiFireStep(c, ship, missiles, dt) {
    const a = c.ai, A = CFG.AI; if (!a) return null;
    a.cd = Math.max(0, a.cd - dt);
    if (c.sunk || (c.dead && c.dead[2])) return null; // weapons destroyed
    const fx = a.fix && (a.fix.host || a.known === "host") ? a.fix : null, solid = a.state === "engage" && a.tracks && a.q > A.FIRE_Q; // solid track on us, else a FIX it knows is hostile
    if (a.cd > 0 || ship.sunk || (!solid && !fx)) return null;
    const d = solid ? Math.hypot(ship.x - c.x, ship.y - c.y) : Math.hypot(fx.x - c.x, fx.y - c.y);
    const opts = ["ssm", "asm"].filter(k => a.ammo[k] > 0 && d <= CFG.WEAPONS[k].range); // weapons that can reach us
    if (!opts.length) return null;
    const w = opts[Math.floor(rand(a) * opts.length)]; // random mix
    a.ammo[w]--; a.cd = A.FIRE_CD; ++ship.nEnemy;
    const m = { uid: ++ship.uid, n: ship.nEnemy, lbl: "H" + ship.nEnemy, side: "enemy", w, tid: "own", x: c.x, y: c.y,
      hdg: norm(Math.atan2((solid ? ship.x : fx.x) - c.x, (solid ? ship.y : fx.y) - c.y) * 180 / Math.PI), spd: CFG.WEAPONS[w].speed, fuel: CFG.WEAPONS[w].range };
    if (!solid) { m.tx = fx.x; m.ty = fx.y; } // fired at a FIX: flies to that point, seeker acquires us if we are within range of it
    missiles.push(m); return m;
  }
  const api = { toggleLink, newAlly, allyStep, rays, fixStep, aiFixStep, initEnemy, resetEnemy, aiDefStep, aiSamMove, resetAi, aiIdTime, aiFireStep, newAi, aiStep, ciwsStep, ecmStep, toggleEcm, deployDecoy, launchSam, setCiws, stepDefense, reap, defCheck, CFG, norm, diff, newShip, step, newRadar, newContact, pDetect, radarStep, setTag, stepContact, newEsm, pEsm, esmStep, startIdentify, cancelIdentify, identifyStep, identifyTime, fireCheck, startFire, cancelFire, fireStep, stepMissiles, hitShip, debugMissile, resetShip, STN };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sim = api;
})(typeof self !== "undefined" ? self : this);
