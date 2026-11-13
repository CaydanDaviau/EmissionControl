import test from "node:test";
import assert from "node:assert/strict";
import { genCode, normCode, cleanName, roomInit, route, listRooms, LIMITS, CODE_ALPHABET } from "../signal/src/logic.mjs";
import worker, { Room, Lobby } from "../signal/src/worker.mjs";

// ---- fakes: Durable Object storage / namespaces / sockets ----
const mkStorage = () => { const m = new Map(); return { m, get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => m.delete(k), deleteAll: async () => m.clear(), list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))) }; };
const mkSock = att => { const s = { att, out: [], closed: null, serializeAttachment: v => { s.att = v; }, deserializeAttachment: () => s.att, send: x => s.out.push(JSON.parse(x)), close: (c, r) => { s.closed = [c, r]; } }; return s; };
const mkRoomEnv = () => { const lobbyDo = new Lobby({ storage: mkStorage() }), rooms = new Map(), env = {};
  env.LOBBY = { idFromName: n => n, get: () => ({ fetch: (u, o) => lobbyDo.fetch(new Request(u, o)) }) };
  env.ROOM = { idFromName: n => n, get: id => { if (!rooms.has(id)) { const ctx = { storage: mkStorage(), sockets: [], getWebSockets() { return this.sockets; }, acceptWebSocket(w) { this.sockets.push(w); } }; rooms.set(id, new Room(ctx, env)); } const r = rooms.get(id); return { fetch: (u, o) => r.fetch(u instanceof Request ? u : new Request(u, o)) }; } };
  return { env, rooms, lobbyDo }; };

test("codes: alphabet, length, normalisation", () => {
  let i = 0; const c = genCode(() => (i++ % 32) / 32); assert.equal(c.length, 4); for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
  assert.ok(!/[01OI]/.test(CODE_ALPHABET)); assert.equal(normCode(" k7-qf "), "K7QF");
});
test("roomInit cleans input and clamps max", () => {
  assert.deepEqual(roomInit({ name: "  <b>Hi</b>\n", scenario: "x".repeat(99), public: true, max: 50 }), { name: "bHi/b", scenario: "x".repeat(LIMITS.NAME), public: true, max: LIMITS.MAX_MAX });
  assert.deepEqual(roomInit(null), { name: "Room", scenario: "default", public: false, max: 4 });
  assert.equal(roomInit({ max: 1 }).max, 2); assert.equal(roomInit({ public: "yes" }).public, false);
});
test("route: guests only reach the host, host addresses guests, kick is host-only, junk refused", () => {
  const g = ["g1", "g2"];
  assert.deepEqual(route("guest", "g1", { t: "offer", to: "g2", data: 1 }, []).deliver, [{ to: "host", msg: { t: "offer", from: "g1", data: 1 } }]);
  assert.deepEqual(route("host", "host", { t: "answer", to: "g2", data: "x" }, g).deliver, [{ to: "g2", msg: { t: "answer", from: "host", data: "x" } }]);
  assert.ok(route("host", "host", { t: "ice", to: "nobody" }, g).error);
  assert.deepEqual(route("host", "host", { t: "kick", to: "g1" }, g).close, ["g1"]);
  assert.ok(route("guest", "g1", { t: "kick", to: "g2" }, g).error);
  assert.ok(route("guest", "g1", { t: "cmd" }, g).error); assert.ok(route("guest", "g1", null, g).error); assert.deepEqual(route("guest", "g1", { t: "ping" }, g), {});
});
test("listRooms: public + alive only, newest first, no secrets", () => {
  const now = 1e6, e = (code, o) => ({ code, name: code, scenario: "s", players: 1, max: 4, public: true, updated: now, token: "SECRET", ...o });
  const r = listRooms([e("A", { updated: now - 10 }), e("B", { public: false }), e("C", { updated: now - LIMITS.TTL_MS - 1 }), e("D", { updated: now - 5 })], now);
  assert.deepEqual(r.map(x => x.code), ["D", "A"]); assert.ok(!JSON.stringify(r).includes("SECRET"));
});

test("worker: POST /rooms makes a room, /rooms list shows only public rooms with the live player count", async () => {
  const { env, lobbyDo } = mkRoomEnv();
  const post = b => worker.fetch(new Request("https://x/rooms", { method: "POST", body: JSON.stringify(b) }), env).then(r => r.json());
  const pub = await post({ name: "Alpha", public: true }), priv = await post({ name: "Beta" });
  assert.match(pub.code, /^[A-Z2-9]{4}$/); assert.equal(pub.hostToken.length, 32);
  await lobbyDo.fetch(new Request("https://l/upsert", { method: "POST", body: JSON.stringify({ code: pub.code, name: "Alpha", scenario: "default", public: true, max: 4, players: 2 }) }));
  await lobbyDo.fetch(new Request("https://l/upsert", { method: "POST", body: JSON.stringify({ code: priv.code, name: "Beta", scenario: "default", public: false, max: 4, players: 1 }) }));
  const list = await worker.fetch(new Request("https://x/rooms"), env).then(r => r.json());
  assert.deepEqual(list.rooms, [{ code: pub.code, name: "Alpha", scenario: "default", players: 2, max: 4 }]);
});
test("worker: ws errors (not found, no upgrade, bad token, host not connected); /turn falls back to STUN; CORS", async () => {
  const { env } = mkRoomEnv(), { code, hostToken } = await worker.fetch(new Request("https://x/rooms", { method: "POST", body: "{}" }), env).then(r => r.json());
  const ws = (path, h = { Upgrade: "websocket" }) => worker.fetch(new Request("https://x" + path, { headers: h }), env);
  assert.equal((await ws("/ws/" + code, {})).status, 426);
  assert.equal((await ws("/ws/ZZZZ")).status, 404);
  assert.equal((await ws(`/ws/${code}?token=bad`)).status, 403);
  assert.equal((await ws(`/ws/${code.toLowerCase()}`)).status, 409, "guest before the host connects (code is case-insensitive)");
  const t = await worker.fetch(new Request("https://x/turn"), env); assert.equal(t.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual((await t.json()).iceServers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  assert.equal((await worker.fetch(new Request("https://x/rooms", { method: "OPTIONS" }), env)).status, 204);
  void hostToken;
});
test("worker: /turn normalises Cloudflare credentials and drops :53 urls", async () => {
  const orig = globalThis.fetch; let seen;
  globalThis.fetch = async (u, o) => { seen = { u, o }; return new Response(JSON.stringify({ iceServers: { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"], username: "u", credential: "c" } })); };
  try { const j = await worker.fetch(new Request("https://x/turn"), { TURN_KEY_ID: "K", TURN_API_TOKEN: "T" }).then(r => r.json());
    assert.match(seen.u, /turn\/keys\/K\/credentials\/generate$/); assert.equal(seen.o.headers.authorization, "Bearer T");
    assert.deepEqual(j.iceServers, [{ urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }]);
  } finally { globalThis.fetch = orig; }
});

test("Room: relay, peer events, kick, guest leave, host leave ends the room and delists it", async () => {
  const { env, rooms, lobbyDo } = mkRoomEnv(), { code, hostToken } = await worker.fetch(new Request("https://x/rooms", { method: "POST", body: JSON.stringify({ public: true, max: 3 }) }), env).then(r => r.json());
  const room = rooms.get(code), ctx = room.ctx, meta = await ctx.storage.get("meta");
  const host = mkSock({ id: "host", role: "host", name: "H" }), g1 = mkSock({ id: "g1", role: "guest", name: "A" }), g2 = mkSock({ id: "g2", role: "guest", name: "B" });
  ctx.sockets.push(host, g1, g2);
  await room.webSocketMessage(g1, JSON.stringify({ t: "offer", data: { sdp: 1 } }));
  assert.deepEqual(host.out, [{ t: "offer", from: "g1", data: { sdp: 1 } }]); assert.equal(g2.out.length, 0, "guests never reach other guests");
  await room.webSocketMessage(host, JSON.stringify({ t: "answer", to: "g1", data: 2 }));
  assert.deepEqual(g1.out, [{ t: "answer", from: "host", data: 2 }]);
  await room.webSocketMessage(g1, "{bad"); assert.equal(g1.out.at(-1).t, "err");
  await room.webSocketMessage(g1, JSON.stringify({ t: "ice", pad: "x".repeat(LIMITS.MSG_BYTES) })); assert.equal(g1.out.at(-1).msg, "Bad message.");
  await room.webSocketMessage(host, JSON.stringify({ t: "ping" })); // heartbeat lists the room with 3 players
  assert.equal((await lobbyDo.fetch(new Request("https://l/list")).then(r => r.json())).rooms[0].players, 3);
  await room.webSocketMessage(host, JSON.stringify({ t: "kick", to: "g2" })); assert.deepEqual(g2.closed, [4000, "kicked"]);
  ctx.sockets.splice(ctx.sockets.indexOf(g1), 1); await room.webSocketClose(g1);
  assert.deepEqual(host.out.at(-1), { t: "peer_left", id: "g1" });
  await room.webSocketClose(host); assert.deepEqual(g2.out.at(-1), { t: "host_left" }); assert.equal(g2.closed[0], 4001);
  assert.equal(await ctx.storage.get("meta"), undefined, "room storage wiped");
  assert.equal((await lobbyDo.fetch(new Request("https://l/list")).then(r => r.json())).rooms.length, 0, "delisted");
  void hostToken; void meta;
});
