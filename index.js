// Roll A Cube bot sidecar (Render free tier).
//
// The real bot is a Cloudflare Worker (HTTP interactions — commands, buttons,
// roles, logs, tickets, XP). Serverless can't hold Discord's gateway open and
// can't afford to rasterise images, so this process does the two things the
// Worker can't:
//
//   1. GATEWAY — sits on the websocket (which is what lights the bot's green
//      "online" dot) and forwards the few events the Worker cares about
//      (member joins → welcome card, messages → XP) to POST /gateway/event on
//      the Worker. Message CONTENT is never requested or forwarded — XP only
//      needs "who posted, where, when".
//   2. RENDER — POST /render {kind, data} → PNG (see render.js). The Worker's
//      free plan allows ~10ms CPU per request; a card takes a few hundred.
//
// Both directions are authenticated with an HMAC-SHA256 over the body keyed
// by the bot token — the one secret both sides already hold, so nothing new
// has to be configured on either host.
//
// Zero runtime config beyond DISCORD_TOKEN (required) and PORT (set by the
// host). WORKER_URL can be overridden but defaults to the deployed Worker.
//
// Discord allows only 1000 fresh logins (Identify) per day — exceed that and
// they reset the bot token (it happened once). So this script is built to be
// stingy with connections:
//   • exactly one reconnect can ever be pending (no doubling),
//   • it RESUMES the old session where possible instead of logging in fresh,
//   • fatal close codes (bad token etc.) stop it dead instead of retrying,
//   • fresh logins are additionally spaced out and capped per day.

const http = require("http");
const crypto = require("crypto");
const { render } = require("./render");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN env var is missing");
  process.exit(1);
}
const WORKER_URL = (process.env.WORKER_URL || "https://blockrng-bot.blockrng.workers.dev").replace(/\/$/, "");

// Gateway intents. GUILD_MEMBERS is PRIVILEGED — it has to be switched on in
// the Discord developer portal (Bot → Privileged Gateway Intents → Server
// Members Intent). If it isn't, Discord closes with 4014 and we fall back to
// the non-privileged set so the online dot + XP keep working without joins.
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
let privilegedAllowed = true;
function intents() {
  return INTENT_GUILDS | INTENT_GUILD_MESSAGES | (privilegedAllowed ? INTENT_GUILD_MEMBERS : 0);
}

// ── State ────────────────────────────────────────────────────────────────────

let ws = null;
let connected = false; // READY/RESUMED received and socket still open
let seq = null;
let sessionId = null; // set by READY; lets us Resume instead of Identify
let resumeUrl = null; // gateway told us where to resume
let heartbeatTimer = null;
let gotHeartbeatAck = true;
let reconnectPending = false; // THE guard: only one reconnect in flight, ever
let reconnectDelay = 5000; // grows on repeated failures
let stableTimer = null; // resets backoff only after 60s of staying up
// Never exit on fatal errors — the host would restart the process and retry
// anyway. Park instead and say why on the HTTP endpoint.
let fatalReason = null;

// Fresh-login budget: well under Discord's 1000/day, sliding window.
const IDENTIFY_CAP = 100;
let identifyTimes = [];

// ── Signing ──────────────────────────────────────────────────────────────────

function sign(body) {
  return crypto.createHmac("sha256", TOKEN).update(body).digest("hex");
}

function verify(body, sig) {
  const expected = sign(body);
  if (!sig || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
}

// ── Event forwarding ─────────────────────────────────────────────────────────

// Per-user throttle so a chatty channel doesn't turn into a request per
// message: the Worker only awards XP once a minute per person anyway, so
// anything inside that window is dropped here without a round trip.
const XP_WINDOW_MS = 61 * 1000;
const lastForwarded = new Map(); // userId -> ms

const forwardStats = { sent: 0, failed: 0, dropped: 0 };

async function forward(event) {
  const body = JSON.stringify({ ...event, ts: Date.now() });
  try {
    const res = await fetch(`${WORKER_URL}/gateway/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-gateway-signature": sign(body) },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) forwardStats.sent++;
    else {
      forwardStats.failed++;
      console.log(`forward ${event.t} -> HTTP ${res.status}`);
    }
  } catch (err) {
    forwardStats.failed++;
    console.log(`forward ${event.t} failed: ${err.message || err}`);
  }
}

function onDispatch(t, d) {
  if (t === "GUILD_MEMBER_ADD") {
    if (!d || !d.user || d.user.bot) return;
    forward({
      t,
      guild_id: d.guild_id,
      user: pickUser(d.user),
      joined_at: d.joined_at,
    });
  } else if (t === "MESSAGE_CREATE") {
    if (!d || !d.guild_id || !d.author || d.author.bot || d.webhook_id) return;
    const now = Date.now();
    const last = lastForwarded.get(d.author.id) || 0;
    if (now - last < XP_WINDOW_MS) {
      forwardStats.dropped++;
      return;
    }
    lastForwarded.set(d.author.id, now);
    // Bound the map: forget anyone quiet for an hour.
    if (lastForwarded.size > 5000) {
      for (const [id, ts] of lastForwarded) if (now - ts > 3600 * 1000) lastForwarded.delete(id);
    }
    forward({
      t,
      guild_id: d.guild_id,
      channel_id: d.channel_id,
      message_id: d.id,
      user: pickUser(d.author),
      // The member's server nickname, when the gateway includes it.
      nick: d.member ? d.member.nick || null : null,
    });
  }
}

function pickUser(u) {
  return { id: u.id, username: u.username, global_name: u.global_name || null, avatar: u.avatar || null };
}

// ── HTTP: keep-awake ping + render endpoint ─────────────────────────────────

const port = process.env.PORT || 10000;
const MAX_BODY = 1024 * 1024;

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/render") {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!verify(body, req.headers["x-render-signature"])) {
          res.writeHead(401);
          return res.end("bad signature");
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (_) {
          res.writeHead(400);
          return res.end("bad json");
        }
        try {
          const t0 = Date.now();
          const png = await render(payload.kind, payload.data);
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
          res.end(png);
          console.log(`render ${payload.kind}: ${png.length}B in ${Date.now() - t0}ms`);
        } catch (err) {
          console.error("render failed", err);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`render failed: ${err.message || err}`);
        }
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    const state = fatalReason ? `dead: ${fatalReason}` : connected ? "online" : "connecting";
    const members = privilegedAllowed ? "" : " (no member intent — enable Server Members Intent in the dev portal)";
    res.end(`v2.4 ${state}${members} | forwarded ${forwardStats.sent}, failed ${forwardStats.failed}, throttled ${forwardStats.dropped}`);
  })
  .listen(port, () => console.log(`http on :${port}`));

// ── Discord gateway ──────────────────────────────────────────────────────────

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

function identify() {
  const now = Date.now();
  identifyTimes = identifyTimes.filter((t) => now - t < 24 * 60 * 60 * 1000);
  if (identifyTimes.length >= IDENTIFY_CAP) {
    // Something is badly wrong (this should never trip with resume working).
    // Refuse to burn through Discord's login limit; try again in an hour.
    console.error(`identify cap hit (${IDENTIFY_CAP}/24h) — backing off 1h`);
    cleanup();
    scheduleReconnect(60 * 60 * 1000);
    return;
  }
  identifyTimes.push(now);
  ws.send(
    JSON.stringify({
      op: 2,
      d: {
        token: TOKEN,
        intents: intents(),
        properties: { os: "linux", browser: "blockrng-presence", device: "blockrng-presence" },
        presence: {
          status: "online",
          activities: [{ name: "Roll A Cube", type: 0 }], // "Playing Roll A Cube"
          since: null,
          afk: false,
        },
      },
    })
  );
}

function resume() {
  ws.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq } }));
}

// Tear down the current socket WITHOUT letting its close event schedule
// anything — the caller decides what happens next. This is what prevents the
// "op 7 handler reconnects AND onclose reconnects" doubling storm that got the
// old token reset.
function cleanup() {
  connected = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
  if (ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch (_) {}
  }
  ws = null;
}

function scheduleReconnect(ms) {
  if (fatalReason || reconnectPending) return;
  reconnectPending = true;
  setTimeout(() => {
    reconnectPending = false;
    connect();
  }, ms);
}

function fail(reason) {
  fatalReason = reason;
  cleanup();
  console.error(`FATAL: ${reason} — not retrying (fix, then redeploy/restart)`);
}

function connect() {
  if (fatalReason) return;
  // Resume goes to the session's own gateway URL; fresh logins to the main one.
  const url = sessionId && resumeUrl ? resumeUrl : GATEWAY;
  console.log(`connecting to gateway (${sessionId ? "resume" : "fresh"})...`);
  ws = new WebSocket(url);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.s != null) seq = msg.s;

    if (msg.op === 10) {
      // Hello → heartbeat forever, then resume or identify.
      const interval = msg.d.heartbeat_interval;
      gotHeartbeatAck = true;
      heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!gotHeartbeatAck) {
          // Zombie connection: Discord stopped acking. Kill + resume.
          console.log("heartbeat not acked — reconnecting");
          cleanup();
          scheduleReconnect(2000);
          return;
        }
        gotHeartbeatAck = false;
        ws.send(JSON.stringify({ op: 1, d: seq }));
      }, interval);
      if (sessionId) resume();
      else identify();
    } else if (msg.op === 11) {
      gotHeartbeatAck = true;
    } else if (msg.op === 7) {
      // Gateway asks us to reconnect (routine) — resume, don't re-login.
      console.log("gateway asked to reconnect (op 7)");
      cleanup();
      scheduleReconnect(2000);
    } else if (msg.op === 9) {
      // Invalid session. d=true → resumable; d=false → must login fresh.
      console.log(`invalid session (resumable: ${msg.d === true})`);
      if (msg.d !== true) {
        sessionId = null;
        resumeUrl = null;
      }
      cleanup();
      // Discord docs: wait a few seconds before re-identifying.
      scheduleReconnect(3000 + Math.floor(Math.random() * 3000));
    } else if (msg.op === 0) {
      if (msg.t === "READY") {
        connected = true;
        sessionId = msg.d.session_id;
        resumeUrl = msg.d.resume_gateway_url ? `${msg.d.resume_gateway_url}/?v=10&encoding=json` : null;
        console.log(`online as ${msg.d.user.username} (intents ${intents()})`);
        // Only call the connection healthy (and reset backoff) once it has
        // actually stayed up a while — READY followed by an instant drop
        // shouldn't reset the brakes.
        stableTimer = setTimeout(() => {
          reconnectDelay = 5000;
        }, 60 * 1000);
      } else if (msg.t === "RESUMED") {
        connected = true;
        console.log("session resumed");
        stableTimer = setTimeout(() => {
          reconnectDelay = 5000;
        }, 60 * 1000);
      } else {
        try {
          onDispatch(msg.t, msg.d);
        } catch (err) {
          console.log(`dispatch ${msg.t} threw: ${err.message || err}`);
        }
      }
    }
  };

  ws.onclose = (event) => {
    const code = event.code || 0;
    // Close codes that retrying can never fix — park instead of hammering
    // Discord with doomed logins (that's how tokens get force-reset).
    if (code === 4004) return fail("authentication failed — DISCORD_TOKEN is wrong/reset");
    if (code === 4014 && privilegedAllowed) {
      // Disallowed intents: the Server Members Intent isn't enabled on the
      // app. Drop it and log in again WITHOUT it rather than parking — the
      // online dot and XP still work; only join cards go missing until it's
      // switched on and the service restarted.
      privilegedAllowed = false;
      sessionId = null;
      resumeUrl = null;
      console.error("gateway 4014: Server Members Intent is not enabled — retrying without it (join cards disabled)");
      cleanup();
      scheduleReconnect(5000);
      return;
    }
    if (code === 4010 || code === 4011 || code === 4012 || code === 4013 || code === 4014) {
      return fail(`unrecoverable gateway close (${code})`);
    }
    // 4007 (bad seq) and 4009 (session timed out) need a fresh login.
    if (code === 4007 || code === 4009) {
      sessionId = null;
      resumeUrl = null;
    }
    console.log(`gateway closed (${code}) — retrying in ${reconnectDelay / 1000}s`);
    cleanup();
    scheduleReconnect(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15 * 60 * 1000);
  };

  ws.onerror = () => {
    // onclose fires right after; nothing to do here.
  };
}

connect();
