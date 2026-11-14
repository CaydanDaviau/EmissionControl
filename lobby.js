// Room (pre-match) state: players and teams. Pure and DOM-free; the host owns it and broadcasts {t:"room"} to guests. Teams: "A", "S" (spectators), "B".
(function (root) {
  const newRoom = (o, hostId, hostName) => ({ name: o.name, mode: o.mode === "solo" ? "solo" : "crew", pvp: o.pvp === "pve" ? "pve" : "pvp", max: o.max || 4, scenario: o.scenario || "default", players: [{ id: hostId, name: hostName, team: "S" }] });
  const cap = r => r.mode === "solo" ? Math.ceil(r.max / 2) : Infinity; // solo ship: one player per ship, so a team holds at most half the room (5v5 at 10)
  const find = (r, id) => r.players.find(p => p.id === id);
  function add(r, id, name) { if (find(r, id)) return true; if (r.players.length >= r.max) return false; r.players.push({ id, name, team: "S" }); return true; }
  const remove = (r, id) => { r.players = r.players.filter(p => p.id !== id); };
  function move(r, id, to) { const p = find(r, id); if (!p) return { ok: false, msg: "No such player." }; if (!["A", "S", "B"].includes(to)) return { ok: false, msg: "Bad team." };
    if (p.team === to) return { ok: true }; if (to !== "S" && r.players.filter(q => q.team === to).length >= cap(r)) return { ok: false, msg: "Team is full." }; p.team = to; return { ok: true }; }
  const view = (r, you) => ({ name: r.name, mode: r.mode, pvp: r.pvp, max: r.max, scenario: r.scenario, you, players: r.players.map(p => ({ id: p.id, name: p.name, team: p.team })) });
  const api = { newRoom, cap, add, remove, move, view, find };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Lobby = api;
})(typeof self !== "undefined" ? self : this);
