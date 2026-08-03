// Roll A Cube presence sidecar.
//
// The real bot is a Cloudflare Worker (HTTP interactions — commands, roles,
// logs). Serverless can't hold Discord's gateway connection open, so the bot
// shows as offline. This script's ONLY job is to sit on that connection and
// keep the green "online" dot lit. It handles zero commands and zero events.
//
// Zero dependencies: Node 21+ ships a global WebSocket. Env: DISCORD_TOKEN
// (required), PORT (set by the host). The tiny HTTP server answers the
// keep-awake pings that stop the free-tier host from sleeping.
//
// Discord allows only 1000 fresh logins (Identify) per day — exceed that and
// they reset the bot token (it happened once). So this script is built to be
// stingy with connections:
//   • exactly one reconnect can ever be pending (no doubling),
//   • it RESUMES the old session where possible instead of logging in fresh,
//   • fatal close codes (bad token etc.) stop it dead instead of retrying,
//   • fresh logins are additionally spaced out and capped per day.

const http = require("http");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN env var is missing");
  process.exit(1);
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

// ── Keep-awake HTTP endpoint ─────────────────────────────────────────────────

const port = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(fatalReason ? `dead: ${fatalReason}` : connected ? "online" : "connecting");
  })
  .listen(port, () => console.log(`ping server on :${port}`));

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
        intents: 0, // presence needs no events at all
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
    } else if (msg.t === "READY") {
      connected = true;
      sessionId = msg.d.session_id;
      resumeUrl = msg.d.resume_gateway_url ? `${msg.d.resume_gateway_url}/?v=10&encoding=json` : null;
      console.log(`online as ${msg.d.user.username}`);
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
    }
  };

  ws.onclose = (event) => {
    const code = event.code || 0;
    // Close codes that retrying can never fix — park instead of hammering
    // Discord with doomed logins (that's how tokens get force-reset).
    if (code === 4004) return fail("authentication failed — DISCORD_TOKEN is wrong/reset");
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
