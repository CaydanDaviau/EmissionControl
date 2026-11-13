// EMCON signaling server (Cloudflare Worker + Durable Objects). Rooms, public room list, WebRTC signaling relay, TURN credentials.
// The game itself never passes through here: the host runs the sim and peers talk over WebRTC DataChannels.
import { genCode, normCode, cleanName, roomInit, route, listRooms, LIMITS } from "./logic.mjs";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const STUN = { urls: ["stun:stun.cloudflare.com:3478"] };

async function turnServers(env) { // short-lived Cloudflare TURN credentials; falls back to STUN only when not configured or on error
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, { method: "POST", headers: { authorization: "Bearer " + env.TURN_API_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ ttl: 3600 }) });
      if (r.ok) { const j = await r.json(), s = j.iceServers, list = Array.isArray(s) ? s : [s]; // browsers block port 53 URLs: drop them
        return list.filter(Boolean).map(x => ({ ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(u => !/:53(\?|$)/.test(u)) })); }
    } catch (e) { /* fall through to STUN */ }
  }
  return [STUN];
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (p === "/rooms" && req.method === "POST") {
      let body; try { body = await req.json(); } catch (e) { body = {}; }
      const init = roomInit(body), token = hex(16);
      for (let i = 0; i < 8; i++) {
        const code = genCode(Math.random), r = await env.ROOM.get(env.ROOM.idFromName(code)).fetch("https://room/init", { method: "POST", body: JSON.stringify({ ...init, code, token }) });
        if (r.status === 200) return json({ code, hostToken: token, max: init.max, public: init.public });
      }
      return json({ error: "Could not allocate a room code." }, 503);
    }
    if (p === "/rooms" && req.method === "GET") { const r = await env.LOBBY.get(env.LOBBY.idFromName("main")).fetch("https://lobby/list"); return new Response(r.body, { headers: { ...CORS, "content-type": "application/json" } }); }
    if (p === "/turn") return json({ iceServers: await turnServers(env) });
    const m = p.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(normCode(m[1]))).fetch(req);
    }
    return json({ ok: true, service: "emissioncontrol" });
  },
};

// One room = one Durable Object. Hibernatable WebSockets: each socket carries {id, role, name}.
export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  socks(except) { return this.ctx.getWebSockets().filter(w => w !== except).map(w => ({ w, a: w.deserializeAttachment() || {} })); }
  send(w, o) { try { w.send(JSON.stringify(o)); } catch (e) { /* socket gone */ } }
  async report(meta, except) { // keep the public room list fresh (also the host heartbeat)
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("main")), n = this.socks(except).length;
    await lobby.fetch(meta ? "https://lobby/upsert" : "https://lobby/remove", { method: "POST", body: JSON.stringify(meta ? { code: meta.code, name: meta.name, scenario: meta.scenario, public: meta.public, max: meta.max, players: n } : { code: except && except.code }) });
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/init") {
      if (await this.ctx.storage.get("meta")) return new Response("taken", { status: 409 });
      const b = await req.json(); await this.ctx.storage.put("meta", { code: b.code, name: b.name, scenario: b.scenario, public: b.public, max: b.max, token: b.token });
      return new Response("ok");
    }
    const meta = await this.ctx.storage.get("meta"); if (!meta) return new Response("No such room", { status: 404 });
    const token = url.searchParams.get("token"), isHost = token !== null;
    if (isHost && token !== meta.token) return new Response("Bad token", { status: 403 });
    const all = this.socks(), host = all.find(s => s.a.role === "host");
    if (!isHost) { if (!host) return new Response("Host not connected", { status: 409 }); if (all.length >= meta.max) return new Response("Room full", { status: 409 }); }
    if (isHost && host) host.w.close(1000, "replaced"); // host reconnect: the old socket may not have closed yet
    const [client, server] = Object.values(new WebSocketPair()), id = isHost ? "host" : "g" + hex(2), role = isHost ? "host" : "guest", name = cleanName(url.searchParams.get("name"), isHost ? "Host" : "Guest");
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ id, role, name });
    this.send(server, { t: "hello", id, role, code: meta.code, max: meta.max, name: meta.name, scenario: meta.scenario });
    if (isHost) this.send(server, { t: "peers", peers: this.socks(server).filter(s => s.a.role === "guest").map(s => ({ id: s.a.id, name: s.a.name })) });
    else if (host) this.send(host.w, { t: "peer", id, name });
    await this.report(meta);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    const a = ws.deserializeAttachment() || {}, s = typeof data === "string" ? data : "";
    if (!s || s.length > LIMITS.MSG_BYTES) return this.send(ws, { t: "err", msg: "Bad message." });
    let msg; try { msg = JSON.parse(s); } catch (e) { return this.send(ws, { t: "err", msg: "Bad message." }); }
    const others = this.socks(ws), r = route(a.role, a.id, msg, others.filter(x => x.a.role === "guest").map(x => x.a.id));
    if (r.error) return this.send(ws, { t: "err", msg: r.error });
    if (msg.t === "ping" && a.role === "host") await this.report(await this.ctx.storage.get("meta")); // host heartbeat keeps the room listed
    for (const d of r.deliver || []) { const t = others.find(x => x.a.id === d.to); if (t) this.send(t.w, d.msg); }
    for (const id of r.close || []) { const t = others.find(x => x.a.id === id); if (t) { this.send(t.w, { t: "kicked" }); t.w.close(4000, "kicked"); } }
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    const a = ws.deserializeAttachment() || {}, meta = await this.ctx.storage.get("meta"); if (!meta) return;
    if (a.role === "host") { // host left: the room ends
      for (const s of this.socks(ws)) { this.send(s.w, { t: "host_left" }); s.w.close(4001, "host left"); }
      await this.report(null, { code: meta.code }); await this.ctx.storage.deleteAll();
    } else {
      const host = this.socks(ws).find(s => s.a.role === "host"); if (host) this.send(host.w, { t: "peer_left", id: a.id });
      await this.report(meta, ws);
    }
  }
}

// The public room list: one small Durable Object keeping an entry per public room (expires without host heartbeat).
export class Lobby {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const p = new URL(req.url).pathname, st = this.ctx.storage;
    if (p === "/upsert") { const b = await req.json(); await st.put("r:" + b.code, { ...b, updated: Date.now() }); return new Response("ok"); }
    if (p === "/remove") { const b = await req.json(); await st.delete("r:" + b.code); return new Response("ok"); }
    const now = Date.now(), all = [...(await st.list({ prefix: "r:" })).entries()];
    for (const [k, e] of all) if (now - e.updated > LIMITS.TTL_MS * 5) await st.delete(k); // sweep long-dead entries
    return new Response(JSON.stringify({ rooms: listRooms(all.map(([, e]) => e), now) }), { headers: { "content-type": "application/json" } });
  }
}
