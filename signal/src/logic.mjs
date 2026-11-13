// Pure signaling logic (no Cloudflare APIs): room codes, input cleaning, message routing, room list. Tested in node (tests/signal.test.mjs).
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const LIMITS = { MSG_BYTES: 8192, NAME: 24, TTL_MS: 120000, LIST: 50, MAX_MIN: 2, MAX_MAX: 8 };

export function genCode(rand, n = 4) { let s = ""; for (let i = 0; i < n; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]; return s; }
export const normCode = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
export function cleanName(s, fallback) { const t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, LIMITS.NAME); return t || fallback; }

export function roomInit(b) {
  b = b && typeof b === "object" ? b : {};
  const mx = Math.round(Number(b.max)) || 4;
  return { name: cleanName(b.name, "Room"), scenario: cleanName(b.scenario, "default"), public: b.public === true, max: Math.max(LIMITS.MAX_MIN, Math.min(LIMITS.MAX_MAX, mx)) };
}

const RELAY = new Set(["offer", "answer", "ice"]);
// route(role, fromId, msg, guestIds) -> {deliver:[{to,msg}], close:[id], error?}. Guests can only talk to the host; the host addresses a guest with msg.to or kicks it.
export function route(role, from, msg, guestIds) {
  if (!msg || typeof msg.t !== "string") return { error: "Bad message." };
  if (msg.t === "ping") return {};
  if (msg.t === "kick") { if (role !== "host") return { error: "Host only." }; if (!guestIds.includes(msg.to)) return { error: "No such player." }; return { close: [msg.to] }; }
  if (!RELAY.has(msg.t)) return { error: "Unknown message." };
  const to = role === "guest" ? "host" : msg.to;
  if (role === "host" && !guestIds.includes(to)) return { error: "No such player." };
  return { deliver: [{ to, msg: { t: msg.t, from, data: msg.data } }] };
}

// listRooms(entries, now): public, still-alive (heartbeat within TTL) rooms, newest first, public fields only (never the host token).
export function listRooms(entries, now) {
  return entries.filter(e => e.public && now - e.updated <= LIMITS.TTL_MS).sort((a, b) => b.updated - a.updated).slice(0, LIMITS.LIST)
    .map(e => ({ code: e.code, name: e.name, scenario: e.scenario, players: e.players, max: e.max }));
}
