// EMCON multiplayer transport: Cloudflare signaling (WebSocket) + WebRTC DataChannel. Host = authority; guests talk only to the host.
// Slice 1: connect + ping test only. Game messages (cmd/view) come later over the same channel.
(function (root) {
  const BASE = "https://emissioncontrol.caydanphoenix14.workers.dev";
  const api = async (path, opt) => { const r = await fetch(BASE + path, opt); if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error || t; } catch (e) {} throw new Error(m || r.status); } return r.json(); };
  const iceServers = async () => { try { return (await api("/turn")).iceServers; } catch (e) { return [{ urls: "stun:stun.cloudflare.com:3478" }]; } };

  // handlers: onStatus(str), onPeer(id,name,"open"|"closed"), onMsg(from,obj), onRtt(id,ms), onEnd(reason)
  function make(h) {
    const S = { role: null, ws: null, id: null, code: null, pcs: {}, dcs: {}, h, hb: null };
    const st = s => h.onStatus && h.onStatus(s);
    const sendWs = o => { try { S.ws.send(JSON.stringify(o)); } catch (e) {} };
    const wire = (peer, dc) => {
      S.dcs[peer] = dc;
      dc.onopen = () => { st("Connected: " + peer); h.onPeer && h.onPeer(peer, null, "open"); if (S.role === "guest") S.ping(peer); };
      dc.onclose = () => h.onPeer && h.onPeer(peer, null, "closed");
      dc.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.t === "ping") return dc.send(JSON.stringify({ t: "pong", ts: m.ts }));
        if (m.t === "pong") return h.onRtt && h.onRtt(peer, Math.round(performance.now() - m.ts));
        h.onMsg && h.onMsg(peer, m);
      };
    };
    const newPc = async peer => {
      const pc = new RTCPeerConnection({ iceServers: await iceServers() }); S.pcs[peer] = pc;
      pc.onicecandidate = e => { if (e.candidate) sendWs({ t: "ice", to: peer, data: e.candidate }); };
      pc.onconnectionstatechange = () => { st("Link " + peer + ": " + pc.connectionState); if (pc.connectionState === "failed") h.onPeer && h.onPeer(peer, null, "closed"); };
      return pc;
    };
    S.ping = peer => { const dc = S.dcs[peer]; if (dc && dc.readyState === "open") dc.send(JSON.stringify({ t: "ping", ts: performance.now() })); };
    S.send = (peer, o) => { const dc = S.dcs[peer]; if (dc && dc.readyState === "open") dc.send(JSON.stringify(o)); };
    S.close = () => { clearInterval(S.hb); try { S.ws && S.ws.close(); } catch (e) {} Object.values(S.pcs).forEach(p => { try { p.close(); } catch (e) {} }); S.pcs = {}; S.dcs = {}; };

    S.open = (wsUrl) => new Promise((res, rej) => {
      const ws = S.ws = new WebSocket(wsUrl); let done = false;
      ws.onerror = () => { if (!done) { done = true; rej(new Error("Cannot reach the room.")); } };
      ws.onclose = e => { if (!done) { done = true; rej(new Error(e.reason || "Room closed.")); } else h.onEnd && h.onEnd(e.reason || "closed"); };
      ws.onmessage = async e => {
        const m = JSON.parse(e.data);
        if (m.t === "hello") { S.id = m.id; S.role = m.role; S.code = m.code; if (!done) { done = true; res(m); } if (S.role === "host") S.hb = setInterval(() => sendWs({ t: "ping" }), 20000); }
        else if (m.t === "peers") for (const p of m.peers) await S.offerTo(p.id, p.name);
        else if (m.t === "peer") await S.offerTo(m.id, m.name);
        else if (m.t === "peer_left") { h.onPeer && h.onPeer(m.id, null, "closed"); const p = S.pcs[m.id]; if (p) p.close(); delete S.pcs[m.id]; delete S.dcs[m.id]; }
        else if (m.t === "offer") { // guest side
          const pc = await newPc("host"); pc.ondatachannel = ev => wire("host", ev.channel);
          await pc.setRemoteDescription(m.data); const a = await pc.createAnswer(); await pc.setLocalDescription(a); sendWs({ t: "answer", data: pc.localDescription });
        } else if (m.t === "answer") { const pc = S.pcs[m.from]; if (pc) await pc.setRemoteDescription(m.data); }
        else if (m.t === "ice") { const pc = S.pcs[S.role === "host" ? m.from : "host"]; if (pc) try { await pc.addIceCandidate(m.data); } catch (x) {} }
        else if (m.t === "host_left") h.onEnd && h.onEnd("Host left.");
        else if (m.t === "kicked") h.onEnd && h.onEnd("Kicked.");
        else if (m.t === "err") st("Server: " + m.msg);
      };
    });
    S.offerTo = async (peer, name) => { // host creates the DataChannel and the offer for each guest
      const pc = await newPc(peer), dc = pc.createDataChannel("game", { ordered: true }); wire(peer, dc);
      h.onPeer && h.onPeer(peer, name, "joining");
      const o = await pc.createOffer(); await pc.setLocalDescription(o); sendWs({ t: "offer", to: peer, data: pc.localDescription });
    };
    return S;
  }

  root.Net = {
    list: () => api("/rooms").then(j => j.rooms || []),
    async host(opts, h) { // opts {name, scenario, public, mode, pvp, password, max, player}
      const r = await api("/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts) });
      const S = make(h); await S.open(BASE.replace("https", "wss") + "/ws/" + r.code + "?token=" + r.hostToken + "&name=" + encodeURIComponent(opts.player || "Host")); return S;
    },
    async joinBy(o, h) { // o {name | code, password, player}: the Worker checks the password and hands back the code + a one-minute ticket
      const r = await api("/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: o.name, code: o.code, password: o.password }) });
      const S = make(h); await S.open(BASE.replace("https", "wss") + "/ws/" + r.code + "?name=" + encodeURIComponent(o.player || "Guest") + (r.ticket ? "&ticket=" + r.ticket : "")); return S;
    },
    async join(code, name, h) { const S = make(h); code = String(code || "").trim().toUpperCase(); await S.open(BASE.replace("https", "wss") + "/ws/" + code + "?name=" + encodeURIComponent(name || "Guest")); return S; },
  };
})(typeof window !== "undefined" ? window : globalThis);
