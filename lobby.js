// Room (pre-match) state: players and teams. Pure and DOM-free; the host owns it and broadcasts {t:"room"} to guests. Teams: "A", "S" (spectators), "B".
(function (root) {
  const SHIP_TYPES = [{ id: "ddg51", name: "Arleigh Burke (DDG-51)" }]; // more as units get added
  const ROLES = ["NAVIGATION", "SENSORS", "WEAPONS", "DEFENSE"]; // = station index 0..3
  const CREW = 4, MAX_SHIPS = 8;
  const mkShip = () => ({ type: SHIP_TYPES[0].id, cap: null, roles: [null, null, null, null], ready: false });
  const newRoom = (o, hostId, hostName) => { const mode = o.mode === "solo" ? "solo" : "crew";
    return { name: o.name, mode, pvp: o.pvp === "pve" ? "pve" : "pvp", max: o.max || 4, scenario: o.scenario || "default", players: [{ id: hostId, name: hostName, team: "S", ship: null }], ships: mode === "crew" ? { A: [mkShip()], B: [mkShip()] } : null }; }; // crew mode: ships per side (empty ship = AI)
  const cap = r => r.mode === "solo" ? Math.ceil(r.max / 2) : Infinity; // solo ship: one player per ship, so a team holds at most half the room (5v5 at 10)
  const find = (r, id) => r.players.find(p => p.id === id);
  const crewOf = (r, team, i) => r.players.filter(p => p.team === team && p.ship === i).sort((a, b) => (a.at || 0) - (b.at || 0)); // in the order they were placed (the first one is the default captain)
  function fixShip(r, team, i) { const sh = r.ships && r.ships[team][i]; if (!sh) return; const m = crewOf(r, team, i).map(p => p.id); // keep captain/roles pointing at members
    if (!m.includes(sh.cap)) sh.cap = m[0] || null; sh.roles = sh.roles.map(x => (m.includes(x) ? x : null)); if (!m.length) sh.ready = false; }
  const fixAll = r => { if (r.ships) for (const t of ["A", "B"]) r.ships[t].forEach((_, i) => fixShip(r, t, i)); };
  function add(r, id, name) { if (find(r, id)) return true; if (r.players.length >= r.max) return false; r.players.push({ id, name, team: "S", ship: null }); return true; }
  const remove = (r, id) => { r.players = r.players.filter(p => p.id !== id); fixAll(r); };
  function move(r, id, to) { const p = find(r, id); if (!p) return { ok: false, msg: "No such player." }; if (!["A", "S", "B"].includes(to)) return { ok: false, msg: "Bad team." };
    if (r.mode === "crew") return { ok: false, msg: "Crew mode: assign players to ships." };
    if (p.team === to) return { ok: true }; if (to !== "S" && r.players.filter(q => q.team === to).length >= cap(r)) return { ok: false, msg: "Team is full." }; p.team = to; return { ok: true }; }
  // roles for the unassigned stations: random, spread so every crew member gets at least one when there are enough stations (called at match start)
  function autoRoles(r, rand) { if (!r.ships) return; for (const t of ["A", "B"]) r.ships[t].forEach((sh, i) => { const m = crewOf(r, t, i).map(p => p.id); if (!m.length) return;
    const cnt = id => sh.roles.filter(x => x === id).length; const free = [0, 1, 2, 3].filter(k => !sh.roles[k]);
    while (free.length) { const k = free.splice(Math.floor(rand() * free.length), 1)[0], low = Math.min(...m.map(cnt)), pool = m.filter(id => cnt(id) === low); sh.roles[k] = pool[Math.floor(rand() * pool.length)]; } }); }
  // act(room, fromId, msg): every room-screen action from the host or a guest; permission rules live here. "host" is the host's id.
  function act(r, from, msg) { const host = from === "host", NO = m => ({ ok: false, msg: m }), OK = { ok: true }, sh = msg && r.ships && r.ships[msg.team] && r.ships[msg.team][msg.ship];
    if (!msg || typeof msg.a !== "string") return NO("Bad action.");
    const capOrHost = () => sh && (host || sh.cap === from);
    switch (msg.a) {
      case "move": if (!host) return NO("Host only."); return move(r, msg.id, msg.to);
      case "ships": { if (!host) return NO("Host only."); if (r.mode !== "crew" || !r.ships[msg.team]) return NO("Not available."); const n = Math.max(1, Math.min(MAX_SHIPS, Math.round(+msg.n) || 1)), L = r.ships[msg.team];
        while (L.length < n) L.push(mkShip()); if (L.length > n) { L.length = n; for (const p of r.players) if (p.team === msg.team && p.ship >= n) { p.team = "S"; p.ship = null; } } fixAll(r); return OK; }
      case "assign": { if (!host) return NO("Host only."); const p = find(r, msg.id); if (!p) return NO("No such player."); if (r.mode !== "crew") return NO("Not available.");
        if (msg.team === "S") { p.team = "S"; p.ship = null; fixAll(r); return OK; }
        if (!sh) return NO("No such ship."); if (p.team === msg.team && p.ship === msg.ship) return OK; if (crewOf(r, msg.team, msg.ship).length >= CREW) return NO("Ship is full.");
        p.team = msg.team; p.ship = msg.ship; p.at = r.seq = (r.seq || 0) + 1; fixAll(r); return OK; }
      case "captain": { if (!host) return NO("Host only."); if (!sh) return NO("No such ship."); if (!crewOf(r, msg.team, msg.ship).some(p => p.id === msg.id)) return NO("Not on that ship."); sh.cap = msg.id; return OK; }
      case "type": { if (!capOrHost()) return NO("Captain only."); if (!SHIP_TYPES.some(t => t.id === msg.type)) return NO("Unknown ship."); sh.type = msg.type; sh.ready = false; return OK; }
      case "role": { if (!capOrHost()) return NO("Captain only."); if (!(msg.stn >= 0 && msg.stn < 4)) return NO("Bad station."); if (msg.id !== null && !crewOf(r, msg.team, msg.ship).some(p => p.id === msg.id)) return NO("Not on that ship."); sh.roles[msg.stn] = msg.id; sh.ready = false; return OK; }
      case "ready": { if (!sh || sh.cap !== from) return NO("Captain only."); if (msg.on && !crewOf(r, msg.team, msg.ship).length) return NO("Empty ship."); sh.ready = !!msg.on; return OK; }
    }
    return NO("Unknown action.");
  }
  const view = (r, you) => ({ name: r.name, mode: r.mode, pvp: r.pvp, max: r.max, scenario: r.scenario, you, players: r.players.map(p => ({ id: p.id, name: p.name, team: p.team, ship: p.ship, at: p.at || 0 })), ships: r.ships ? { A: r.ships.A.map(s => ({ ...s, roles: s.roles.slice() })), B: r.ships.B.map(s => ({ ...s, roles: s.roles.slice() })) } : null });
  const api = { newRoom, cap, add, remove, move, view, find, act, autoRoles, crewOf, SHIP_TYPES, ROLES, CREW, MAX_SHIPS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Lobby = api;
})(typeof self !== "undefined" ? self : this);
