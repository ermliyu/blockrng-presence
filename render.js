// Card renderer — the PNGs the bot posts (welcome, rank, level-up, leaderboard).
//
// Lives in the sidecar, not the Worker, on purpose: the Worker's free plan
// allows ~10ms of CPU per request and rasterising a 1200px card takes a few
// hundred. Node has no such cap. The Worker sends `{ kind, data }` to POST
// /render (HMAC-signed with the bot token) and gets PNG bytes back.
//
// Layout is Satori (HTML-ish object tree → SVG) rasterised by resvg. Satori
// rules that bite: every element with more than one child MUST be
// display:flex (h() below defaults it), images need explicit width/height,
// and glyphs missing from the bundled fonts are dropped — so names are
// sanitised to Latin before they go in.
//
// Brand: Fredoka One for display text (the game's font), Nunito for body.

const fs = require("fs");
const path = require("path");
const satori = require("satori").default;
const { Resvg, initWasm } = require("@resvg/resvg-wasm");

// ── Fonts + wasm (loaded once) ───────────────────────────────────────────────

const ASSETS = path.join(__dirname, "assets");
const FONTS = [
  { name: "Fredoka", data: fs.readFileSync(path.join(ASSETS, "FredokaOne-Regular.ttf")), weight: 400, style: "normal" },
  { name: "Nunito", data: fs.readFileSync(path.join(ASSETS, "Nunito-Regular.ttf")), weight: 400, style: "normal" },
  { name: "Nunito", data: fs.readFileSync(path.join(ASSETS, "Nunito-Bold.ttf")), weight: 700, style: "normal" },
  { name: "Nunito", data: fs.readFileSync(path.join(ASSETS, "Nunito-ExtraBold.ttf")), weight: 800, style: "normal" },
];

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) {
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
    wasmReady = initWasm(fs.readFileSync(wasmPath)).catch((err) => {
      // "Already initialized" is fine (hot reload); anything else is real.
      if (!String(err).includes("initialized")) throw err;
    });
  }
  return wasmReady;
}

// ── Palette ──────────────────────────────────────────────────────────────────

const C = {
  bg0: "#0a0c1b",
  bg1: "#161238",
  bg2: "#2a1650",
  glass: "rgba(255,255,255,0.055)",
  glassBorder: "rgba(255,255,255,0.14)",
  text: "#ffffff",
  muted: "rgba(255,255,255,0.62)",
  faint: "rgba(255,255,255,0.35)",
  gold: "#ffdd00",
  pink: "#ffb6e3",
  violet: "#a47cff",
  teal: "#2dd4bf",
  orange: "#ff9f43",
};
const RING = `linear-gradient(135deg, ${C.gold} 0%, ${C.pink} 45%, ${C.violet} 75%, ${C.teal} 100%)`;
const TITLE_GRADIENT = `linear-gradient(90deg, #ffffff 0%, ${C.pink} 55%, ${C.violet} 100%)`;

// ── Element helpers ──────────────────────────────────────────────────────────

function h(type, style, ...children) {
  const kids = children.flat().filter((k) => k !== null && k !== undefined && k !== false);
  const props = { style: { display: "flex", ...(style || {}) } };
  if (type === "img") {
    props.src = style.src;
    delete props.style.src;
    props.width = style.width;
    props.height = style.height;
  }
  if (kids.length > 0) props.children = kids.length === 1 ? kids[0] : kids;
  return { type, props };
}
const txt = (s, style) => h("div", { display: "block", ...style }, String(s));

// Keep what the bundled fonts can draw (Latin + Latin-1/Extended-A) and drop
// the rest — emoji, CJK, fancy Unicode "fonts" people put in display names.
function latin(s, fallback) {
  const cleaned = String(s || "")
    .replace(/[^\x20-\x7e -ɏ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback || "Cube";
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

// Fetch an image to a data URI so Satori never does network work mid-layout.
// Any failure → null and the caller draws a placeholder instead.
async function dataUri(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "image/png").split(";")[0];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch (_) {
    return null;
  }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function backdrop(width, height, children, accent) {
  const glow = accent || C.violet;
  return h(
    "div",
    {
      width,
      height,
      position: "relative",
      overflow: "hidden",
      backgroundColor: C.bg0,
      backgroundImage: `linear-gradient(135deg, ${C.bg0} 0%, ${C.bg1} 55%, ${C.bg2} 100%)`,
      fontFamily: "Nunito",
      color: C.text,
    },
    // Two soft light sources so the flat gradient reads as depth.
    h("div", {
      position: "absolute",
      left: -140,
      top: -160,
      width: 520,
      height: 520,
      borderRadius: 260,
      backgroundImage: `radial-gradient(circle, ${glow} 0%, rgba(0,0,0,0) 62%)`,
      opacity: 0.35,
    }),
    h("div", {
      position: "absolute",
      right: -120,
      bottom: -200,
      width: 560,
      height: 560,
      borderRadius: 280,
      backgroundImage: `radial-gradient(circle, ${C.teal} 0%, rgba(0,0,0,0) 60%)`,
      opacity: 0.18,
    }),
    // Floating cubes — the game's motif, kept faint so text stays readable.
    cube(width - 210, -40, 150, 14, C.pink, 0.16),
    cube(width - 90, 120, 70, -20, C.gold, 0.22),
    cube(40, height - 90, 110, 24, C.teal, 0.14),
    cube(width * 0.55, height - 60, 56, -12, C.violet, 0.2),
    ...children
  );
}

function cube(x, y, size, rot, color, opacity) {
  return h("div", {
    position: "absolute",
    left: x,
    top: y,
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.22),
    border: `3px solid ${color}`,
    transform: `rotate(${rot}deg)`,
    opacity,
  });
}

// Glass panel. No box-shadow: resvg-wasm panics ("unreachable") on the huge
// Gaussian blur Satori emits for a panel-sized shadow, so the drop shadow is a
// plain offset dark rect behind the panel instead.
function glass(style, ...children) {
  const { position, left, top, width, height, ...rest } = style;
  return h(
    "div",
    { position, left, top, width, height },
    h("div", {
      position: "absolute",
      left: 0,
      top: 18,
      width,
      height,
      borderRadius: 30,
      backgroundColor: "rgba(0,0,0,0.32)",
    }),
    h(
      "div",
      {
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        backgroundColor: C.glass,
        border: `1px solid ${C.glassBorder}`,
        borderRadius: 30,
        ...rest,
      },
      ...children
    )
  );
}

// Circular avatar with the brand gradient ring. `uri` null → initials disc.
function avatar(uri, size, name, ringWidth) {
  const ring = ringWidth == null ? Math.max(4, Math.round(size * 0.035)) : ringWidth;
  const inner = size - ring * 2;
  const glowPad = Math.round(size * 0.18);
  return h(
    "div",
    { position: "relative", width: size, height: size },
    // Glow = radial gradient disc (a blur filter would crash resvg, see glass()).
    h("div", {
      position: "absolute",
      left: -glowPad,
      top: -glowPad,
      width: size + glowPad * 2,
      height: size + glowPad * 2,
      borderRadius: (size + glowPad * 2) / 2,
      backgroundImage: "radial-gradient(circle, rgba(164,124,255,0.6) 0%, rgba(255,182,227,0.25) 45%, rgba(0,0,0,0) 70%)",
    }),
    h(
      "div",
      {
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundImage: RING,
        padding: ring,
      },
      uri
      ? h("img", { src: uri, width: inner, height: inner, borderRadius: inner / 2 })
      : h(
          "div",
          {
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            backgroundColor: "#1f1b3f",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Fredoka",
            fontSize: Math.round(size * 0.42),
            color: C.pink,
          },
          latin(name, "C").slice(0, 1).toUpperCase()
        )
    )
  );
}

function pill(label, color, style) {
  return h(
    "div",
    {
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 7,
      paddingBottom: 7,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.08)",
      border: `1.5px solid ${color}`,
      color,
      fontSize: 18,
      fontWeight: 800,
      letterSpacing: 1.5,
      ...style,
    },
    label
  );
}

function progressBar(width, ratio, height) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const hgt = height || 26;
  return h(
    "div",
    {
      width,
      height: hgt,
      borderRadius: hgt / 2,
      backgroundColor: "rgba(255,255,255,0.10)",
      border: "1px solid rgba(255,255,255,0.12)",
      overflow: "hidden",
    },
    h("div", {
      width: Math.max(r > 0 ? hgt : 0, Math.round(width * r)),
      height: hgt,
      borderRadius: hgt / 2,
      backgroundImage: RING,
    })
  );
}

function watermark(x, y) {
  return h(
    "div",
    { position: "absolute", left: x, top: y, alignItems: "center" },
    h("div", { width: 10, height: 10, borderRadius: 3, backgroundColor: C.gold, marginRight: 8 }),
    txt("ROLL A CUBE", { fontFamily: "Fredoka", fontSize: 16, letterSpacing: 3, color: C.faint })
  );
}

// ── Welcome card (1200 × 500) ────────────────────────────────────────────────

async function welcome(d) {
  const W = 1200;
  const H = 500;
  const [av, icon] = await Promise.all([dataUri(d.avatarUrl), dataUri(d.gameIconUrl)]);
  const name = clip(latin(d.name, d.username), 16);
  const nameSize = name.length > 12 ? 56 : name.length > 8 ? 66 : 78;
  const joined = d.joinedAt
    ? new Date(d.joinedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  const step = (n, label, color) =>
    h(
      "div",
      { alignItems: "center", marginRight: 22 },
      h(
        "div",
        {
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: color,
          color: "#12102a",
          fontFamily: "Fredoka",
          fontSize: 19,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
        },
        String(n)
      ),
      txt(label, { fontSize: 21, fontWeight: 700, color: "rgba(255,255,255,0.88)" })
    );

  const tree = backdrop(W, H, [
    glass(
      { position: "absolute", left: 36, top: 36, width: W - 72, height: H - 72, padding: 40, alignItems: "center" },
      // Left: avatar + member number
      h(
        "div",
        { flexDirection: "column", alignItems: "center", width: 250 },
        avatar(av, 212, name),
        pill(`MEMBER #${fmt(d.memberNumber)}`, C.gold, { marginTop: 22 })
      ),
      // Middle: copy
      h(
        "div",
        { flexDirection: "column", flexGrow: 1, marginLeft: 44, marginRight: 20, justifyContent: "center" },
        txt("WELCOME TO THE SERVER", { fontSize: 20, fontWeight: 800, letterSpacing: 5, color: C.teal }),
        txt(name, {
          fontFamily: "Fredoka",
          fontSize: nameSize,
          lineHeight: 1.05,
          marginTop: 6,
          backgroundImage: TITLE_GRADIENT,
          backgroundClip: "text",
          color: "transparent",
        }),
        txt(`@${latin(d.username, "cube")}${joined ? `  ·  joined ${joined}` : ""}`, {
          fontSize: 24,
          color: C.muted,
          marginTop: 4,
        }),
        h("div", { height: 1, backgroundColor: C.glassBorder, marginTop: 26, marginBottom: 22, width: 600 }),
        h(
          "div",
          { alignItems: "center" },
          step(1, "Link your Roblox", C.gold),
          step(2, "Grab your code", C.pink),
          step(3, "Say hi", C.teal)
        )
      ),
      // Right: game + live count
      h(
        "div",
        { flexDirection: "column", alignItems: "center", width: 180 },
        icon
          ? h("img", { src: icon, width: 124, height: 124, borderRadius: 30 })
          : h("div", { width: 124, height: 124, borderRadius: 30, backgroundColor: "#1f1b3f", border: `2px solid ${C.gold}` }),
        txt("ROLL A CUBE", { fontFamily: "Fredoka", fontSize: 20, letterSpacing: 2, marginTop: 14, color: C.text }),
        txt(`${fmt(d.memberCount)} members`, { fontSize: 18, color: C.muted, marginTop: 4 }),
        d.updateLabel ? pill(latin(d.updateLabel, ""), C.violet, { marginTop: 14, fontSize: 15 }) : null
      )
    ),
    watermark(60, H - 30),
  ], C.pink);

  return raster(tree, W, H);
}

// ── Rank card (1000 × 340) ───────────────────────────────────────────────────

async function rank(d) {
  const W = 1000;
  const H = 340;
  const [av, head] = await Promise.all([dataUri(d.avatarUrl), dataUri(d.robloxHeadshotUrl)]);
  const name = clip(latin(d.name, d.username), 14);
  const inLevel = Math.max(0, d.xpInLevel || 0);
  const need = Math.max(1, d.xpForLevel || 1);
  // Panel inner width is 880: avatar 176 + gap 36 + middle 488 + right 180.
  const barW = 470;

  const tree = backdrop(W, H, [
    glass(
      { position: "absolute", left: 28, top: 28, width: W - 56, height: H - 56, padding: 32, alignItems: "center" },
      avatar(av, 176, name),
      h(
        "div",
        { flexDirection: "column", width: 488, marginLeft: 36, justifyContent: "center" },
        h(
          "div",
          { alignItems: "flex-end" },
          txt(name, { fontFamily: "Fredoka", fontSize: name.length > 10 ? 40 : 50, lineHeight: 1, color: C.text }),
          txt(`@${latin(d.username, "cube")}`, { fontSize: 22, color: C.muted, marginLeft: 14, marginBottom: 4 })
        ),
        h(
          "div",
          { alignItems: "center", marginTop: 14 },
          d.robloxName
            ? h(
                "div",
                {
                  alignItems: "center",
                  borderRadius: 999,
                  backgroundColor: "rgba(45,212,191,0.12)",
                  border: `1.5px solid ${C.teal}`,
                  paddingLeft: 8,
                  paddingRight: 16,
                  paddingTop: 5,
                  paddingBottom: 5,
                },
                head
                  ? h("img", { src: head, width: 28, height: 28, borderRadius: 14, marginRight: 8 })
                  : h("div", { width: 28, height: 28, borderRadius: 14, backgroundColor: C.teal, marginRight: 8 }),
                txt(`@${latin(d.robloxName, "linked")} linked`, { fontSize: 17, fontWeight: 800, color: C.teal })
              )
            : pill("NOT LINKED · grab a code in #codes", C.orange, { fontSize: 15, letterSpacing: 0.5 }),
          txt(`${fmt(d.messages)} messages`, { fontSize: 18, color: C.muted, marginLeft: 18 })
        ),
        h("div", { marginTop: 26 }, progressBar(barW, inLevel / need, 26)),
        h(
          "div",
          { justifyContent: "space-between", width: barW, marginTop: 10 },
          txt(`${fmt(inLevel)} / ${fmt(need)} XP`, { fontSize: 18, fontWeight: 700, color: C.muted }),
          txt(`${fmt(need - inLevel)} XP to level ${fmt((d.level || 0) + 1)}`, { fontSize: 18, color: C.faint })
        )
      ),
      h(
        "div",
        { flexDirection: "column", alignItems: "flex-end", justifyContent: "center", width: 180, flexShrink: 0 },
        txt("LEVEL", { fontSize: 18, fontWeight: 800, letterSpacing: 5, color: C.pink }),
        txt(String(d.level || 0), {
          fontFamily: "Fredoka",
          fontSize: 104,
          lineHeight: 0.95,
          backgroundImage: TITLE_GRADIENT,
          backgroundClip: "text",
          color: "transparent",
        }),
        pill(`RANK #${fmt(d.rank)}`, C.gold, { marginTop: 10, fontSize: 16 })
      )
    ),
    watermark(52, H - 26),
  ]);

  return raster(tree, W, H);
}

// ── Level-up card (1000 × 380) ───────────────────────────────────────────────

async function levelup(d) {
  const W = 1000;
  const H = 380;
  const av = await dataUri(d.avatarUrl);
  const name = clip(latin(d.name, d.username), 20);

  // Burst rays behind the avatar: bars centred on the avatar (Satori rotates
  // around an element's centre — transform-origin isn't honoured), each
  // fading to nothing through the middle so only the spokes outside the
  // avatar show. 8 bars = 16 spokes.
  const cx = 150;
  const cy = H / 2;
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    const len = long ? 165 : 135;
    const color = long ? C.gold : C.pink;
    rays.push(
      h("div", {
        position: "absolute",
        left: cx - len,
        top: cy - 3,
        width: len * 2,
        height: 6,
        borderRadius: 3,
        backgroundImage: `linear-gradient(90deg, ${color} 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 68%, ${color} 100%)`,
        opacity: 0.75,
        transform: `rotate(${i * 22.5}deg)`,
      })
    );
  }

  const tree = backdrop(W, H, [
    ...rays,
    h(
      "div",
      { position: "absolute", left: 60, top: (H - 180) / 2 },
      avatar(av, 180, name, 7)
    ),
    glass(
      { position: "absolute", left: 290, top: 44, width: W - 290 - 40, height: H - 88, padding: 34, flexDirection: "column", justifyContent: "center" },
      txt("LEVEL UP!", {
        fontFamily: "Fredoka",
        fontSize: 72,
        lineHeight: 1,
        backgroundImage: `linear-gradient(90deg, ${C.gold} 0%, ${C.pink} 60%, ${C.violet} 100%)`,
        backgroundClip: "text",
        color: "transparent",
      }),
      h(
        "div",
        { alignItems: "flex-end", marginTop: 10 },
        txt(name, { fontFamily: "Fredoka", fontSize: 40, lineHeight: 1, color: C.text }),
        txt("is now level", { fontSize: 24, color: C.muted, marginLeft: 12, marginBottom: 3 }),
        txt(String(d.level || 1), { fontFamily: "Fredoka", fontSize: 58, lineHeight: 0.9, color: C.gold, marginLeft: 12 })
      ),
      h("div", { height: 1, backgroundColor: C.glassBorder, marginTop: 22, marginBottom: 18, width: 520 }),
      d.rewardLabel
        ? h(
            "div",
            { alignItems: "center" },
            pill("REWARD UNLOCKED", C.teal, { fontSize: 15 }),
            txt(clip(latin(d.rewardLabel, ""), 44), { fontSize: 22, fontWeight: 700, marginLeft: 14, color: C.text })
          )
        : txt(
            d.nextRewardLevel ? `Next in-game reward at level ${d.nextRewardLevel}` : "Keep chatting to climb the board",
            { fontSize: 22, color: C.muted }
          )
    ),
    watermark(52, H - 26),
  ], C.gold);

  return raster(tree, W, H);
}

// ── Leaderboard (1000 × dynamic) ─────────────────────────────────────────────

async function leaderboard(d) {
  const rows = (d.rows || []).slice(0, 10);
  const W = 1000;
  const ROW = 64;
  const H = 150 + rows.length * (ROW + 4) + 56;
  const avatars = await Promise.all(rows.map((r) => dataUri(r.avatarUrl)));
  const medal = ["#ffd54a", "#cfd8e3", "#d59a66"];

  const tree = backdrop(W, H, [
    glass(
      { position: "absolute", left: 28, top: 28, width: W - 56, height: H - 56, padding: 28, flexDirection: "column" },
      h(
        "div",
        { alignItems: "flex-end", justifyContent: "space-between", marginBottom: 14 },
        h(
          "div",
          { alignItems: "flex-end" },
          txt("TOP CUBES", {
            fontFamily: "Fredoka",
            fontSize: 46,
            lineHeight: 1,
            backgroundImage: TITLE_GRADIENT,
            backgroundClip: "text",
            color: "transparent",
          }),
          txt(`${fmt(d.total)} ranked`, { fontSize: 18, color: C.muted, marginLeft: 16, marginBottom: 4 })
        ),
        txt("chat to earn XP · linked accounts get in-game rewards", { fontSize: 15, color: C.faint, marginBottom: 6 })
      ),
      ...rows.map((r, i) =>
        h(
          "div",
          {
            alignItems: "center",
            height: ROW,
            borderRadius: 16,
            paddingLeft: 14,
            paddingRight: 18,
            marginBottom: 4,
            backgroundColor: i === 0 ? "rgba(255,221,0,0.10)" : i % 2 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.0)",
            border: i === 0 ? `1px solid rgba(255,221,0,0.45)` : "1px solid rgba(255,255,255,0.0)",
          },
          txt(`#${r.rank}`, {
            fontFamily: "Fredoka",
            fontSize: 26,
            width: 64,
            color: medal[i] || C.muted,
          }),
          avatars[i]
            ? h("img", { src: avatars[i], width: 42, height: 42, borderRadius: 21, marginRight: 14 })
            : h("div", { width: 42, height: 42, borderRadius: 21, backgroundColor: "#1f1b3f", marginRight: 14 }),
          txt(clip(latin(r.name, r.username), 26), { fontSize: 24, fontWeight: 800, flexGrow: 1, color: C.text }),
          pill(`LVL ${r.level}`, C.pink, { fontSize: 14, marginRight: 16 }),
          txt(`${fmt(r.xp)} XP`, { fontSize: 20, color: C.muted, width: 140, justifyContent: "flex-end" })
        )
      ),
      rows.length === 0 ? txt("Nobody has XP yet — say something!", { fontSize: 22, color: C.muted, marginTop: 20 }) : null
    ),
    watermark(52, H - 26),
  ]);

  return raster(tree, W, H);
}

// ── Raster ───────────────────────────────────────────────────────────────────

async function raster(tree, width, height) {
  await ensureWasm();
  const svg = await satori(tree, { width, height, fonts: FONTS });
  if (process.env.CARD_DEBUG_SVG) fs.writeFileSync(process.env.CARD_DEBUG_SVG, svg);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return Buffer.from(png);
}

const KINDS = { welcome, rank, levelup, leaderboard };

async function render(kind, data) {
  const fn = KINDS[kind];
  if (!fn) throw new Error(`unknown card kind: ${kind}`);
  return fn(data || {});
}

module.exports = { render, KINDS: Object.keys(KINDS) };
