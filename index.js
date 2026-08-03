// Block RNG presence sidecar.
//
// The real bot is a Cloudflare Worker (HTTP interactions — commands, roles,
// logs). Serverless can't hold Discord's gateway connection open, so the bot
// shows as offline. This script's ONLY job is to sit on that connection and
// keep the green "online" dot lit. It handles zero commands and zero events.
//
// Zero dependencies: Node 21+ ships a global WebSocket. Env: DISCORD_TOKEN
// (required), PORT (set by the host). The tiny HTTP server answers the
// keep-awake pings that stop the free-tier host from sleeping.

const http = require("http");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN env var is missing");
  process.exit(1);
}

// ── Keep-awake HTTP endpoint ─────────────────────────────────────────────────

const port = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(connected ? "online" : "connecting");
  })
  .listen(port, () => console.log(`ping server on :${port}`));

// ── Discord gateway ──────────────────────────────────────────────────────────

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

let ws = null;
let connected = false;
let seq = null;
let heartbeatTimer = null;
let reconnectDelay = 5000; // grows on repeated failures, resets on READY

function identify() {
  ws.send(
    JSON.stringify({
      op: 2,
      d: {
        token: TOKEN,
        intents: 0, // presence needs no events at all
        properties: { os: "linux", browser: "blockrng-presence", device: "blockrng-presence" },
        presence: {
          status: "online",
          activities: [{ name: "Block RNG", type: 0 }], // "Playing Block RNG"
          since: null,
          afk: false,
        },
      },
    })
  );
}

function cleanup() {
  connected = false;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }
  ws = null;
}

function connect() {
  console.log("connecting to gateway...");
  ws = new WebSocket(GATEWAY);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.s != null) seq = msg.s;

    if (msg.op === 10) {
      // Hello → heartbeat forever, then identify.
      const interval = msg.d.heartbeat_interval;
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: seq }));
        }
      }, interval);
      identify();
    } else if (msg.op === 7 || msg.op === 9) {
      // Reconnect request / invalid session → start over.
      console.log(`gateway asked to reconnect (op ${msg.op})`);
      cleanup();
      setTimeout(connect, 3000);
    } else if (msg.t === "READY") {
      connected = true;
      reconnectDelay = 5000;
      console.log(`online as ${msg.d.user.username}`);
    }
  };

  ws.onclose = (event) => {
    console.log(`gateway closed (${event.code}) — retrying in ${reconnectDelay / 1000}s`);
    cleanup();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
  };

  ws.onerror = () => {
    // onclose fires right after; nothing to do here.
  };
}

connect();
