// Card renderer — the PNGs the bot posts (welcome, rank, level-up, leaderboard).
//
// Lives in the sidecar, not the Worker, on purpose: the Worker's free plan
// allows ~10ms of CPU per request and rasterising a 1200px card takes a few
// hundred. Node has no such cap. The Worker sends `{ kind, data }` to POST
// /render (HMAC-signed with the bot token) and gets PNG bytes back.
//
// Look (v2, 2026-08-26 — liyu: "less made with AI"): the game's own language,
// not the dark-gradient/glass/neon-glow template. Flat bright colours, cream
// panels with thick ink outlines and HARD offset shadows, Fredoka with an
// outline, tilted sticker tags, and little cube characters (the pets are
// cubes) instead of glows. No gradients, no blur, no glass.
//
// Satori rules that bite: every element with more than one child MUST be
// display:flex (h() below defaults it), images need explicit width/height,
// glyphs missing from the bundled fonts are dropped (names are sanitised and
// fall back to the username), and resvg-wasm panics on big blur filters — so
// shadows here are plain offset rectangles, never box-shadow.

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
      if (!String(err).includes("initialized")) throw err;
    });
  }
  return wasmReady;
}

// ── Palette ──────────────────────────────────────────────────────────────────

const C = {
  ink: "#2a1a4a",
  cream: "#fff8e7",
  creamDark: "#f3e8d0",
  purple: "#7c5cff",
  purpleStripe: "#8a6eff",
  teal: "#3ddbc2",
  tealStripe: "#52e2cb",
  gold: "#ffdd00",
  goldStripe: "#ffe64d",
  pink: "#ff9ad5",
  pinkStripe: "#ffaadc",
  orange: "#ff9f43",
  white: "#ffffff",
  inkSoft: "rgba(42,26,74,0.62)",
  inkFaint: "rgba(42,26,74,0.38)",
};

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

// Text outline via stacked hard text-shadows (Satori has no text-stroke).
function outline(px, color, drop) {
  const c = color || C.ink;
  const parts = [];
  for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    parts.push(`${x * px}px ${y * px}px 0 ${c}`);
  }
  if (drop) parts.push(`0px ${px + drop}px 0 ${c}`);
  return parts.join(", ");
}

// Chunky display text: Fredoka + ink outline + a little drop.
function big(s, size, fill, style) {
  const px = Math.max(2, Math.round(size * 0.055));
  const drop = Math.round(px * 1.2);
  // Padding keeps the outline + drop inside the element's box: the shadow
  // filter is clipped to it, so an unpadded "S" loses its left edge.
  return txt(s, {
    fontFamily: "Fredoka",
    fontSize: size,
    lineHeight: 1,
    color: fill || C.white,
    textShadow: outline(px, C.ink, drop),
    whiteSpace: "nowrap",
    paddingLeft: px + 2,
    paddingRight: px + 2,
    paddingTop: px,
    paddingBottom: px + drop,
    ...style,
  });
}

// Keep what the bundled fonts can draw (Latin + Latin-1/Extended-A). If the
// name is mostly stylised Unicode (fancy "fonts", symbols) the cleaned result
// is a stump like "ly'" — then use the fallback (username) instead.
function cleanLatin(s) {
  return String(s || "")
    .replace(/[^\x20-\x7e -ɏ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function latin(s, fallback) {
  const raw = String(s || "").replace(/\s+/g, "");
  const cleaned = cleanLatin(s);
  const keep = raw.length ? cleaned.replace(/\s+/g, "").length / raw.length : 0;
  if (cleaned && keep >= 0.6) return cleaned;
  const fb = cleanLatin(fallback);
  return fb || cleaned || "Cube";
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

// Fetch an image to a data URI so Satori never does network work mid-layout.
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

// Flat colour + diagonal stripes, with cube characters in the corners.
function backdrop(width, height, base, stripe, children, cubes) {
  return h(
    "div",
    {
      width,
      height,
      position: "relative",
      overflow: "hidden",
      backgroundColor: base,
      backgroundImage: `repeating-linear-gradient(-45deg, ${base} 0px, ${base} 26px, ${stripe} 26px, ${stripe} 52px)`,
      fontFamily: "Nunito",
      color: C.ink,
    },
    ...(cubes || []),
    ...children
  );
}

// A cube pet: rounded square, ink outline, two eyes and a smile. Tilted.
function cubeFace(x, y, size, color, rot, mood) {
  const eye = Math.max(6, Math.round(size * 0.11));
  const gap = Math.round(size * 0.2);
  const mouthW = Math.round(size * 0.34);
  const mouthH = Math.round(size * 0.16);
  const border = Math.max(4, Math.round(size * 0.05));
  return h(
    "div",
    {
      position: "absolute",
      left: x,
      top: y,
      width: size,
      height: size,
      borderRadius: Math.round(size * 0.2),
      backgroundColor: color,
      border: `${border}px solid ${C.ink}`,
      transform: `rotate(${rot}deg)`,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    },
    h(
      "div",
      { alignItems: "center", marginBottom: Math.round(size * 0.06) },
      h("div", { width: eye, height: eye, borderRadius: eye, backgroundColor: C.ink, marginRight: gap }),
      h("div", { width: eye, height: eye, borderRadius: eye, backgroundColor: C.ink })
    ),
    mood === "wow"
      ? h("div", { width: mouthH, height: mouthH, borderRadius: mouthH, border: `${border}px solid ${C.ink}` })
      : h("div", {
          width: mouthW,
          height: mouthH,
          borderBottom: `${border}px solid ${C.ink}`,
          borderLeft: `${border}px solid ${C.ink}`,
          borderRight: `${border}px solid ${C.ink}`,
          borderRadius: `0 0 ${mouthW}px ${mouthW}px`,
        })
  );
}

// Cream panel with ink outline and a hard offset shadow.
function panel(x, y, w, hgt, style, ...children) {
  const r = (style && style.borderRadius) || 28;
  return h(
    "div",
    { position: "absolute", left: x, top: y, width: w, height: hgt },
    h("div", { position: "absolute", left: 8, top: 10, width: w, height: hgt, borderRadius: r, backgroundColor: C.ink }),
    h(
      "div",
      {
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: hgt,
        borderRadius: r,
        backgroundColor: C.cream,
        border: `5px solid ${C.ink}`,
        ...style,
      },
      ...children
    )
  );
}

// Tilted sticker tag. Positioned by the caller (wrap in a positioned div).
function sticker(label, bgColor, rot, style, textColor) {
  const fontSize = (style && style.fontSize) || 20;
  const padX = Math.round(fontSize * 0.8);
  const padY = Math.round(fontSize * 0.35);
  const outer = { ...(style || {}) };
  delete outer.fontSize;
  return h(
    "div",
    { position: "relative", transform: `rotate(${rot || 0}deg)`, ...outer },
    h("div", { position: "absolute", left: 4, top: 5, right: -4, bottom: -5, borderRadius: 999, backgroundColor: C.ink }),
    h(
      "div",
      {
        position: "relative",
        paddingLeft: padX,
        paddingRight: padX,
        paddingTop: padY,
        paddingBottom: padY,
        borderRadius: 999,
        backgroundColor: bgColor,
        border: `4px solid ${C.ink}`,
        fontFamily: "Fredoka",
        fontSize,
        letterSpacing: 1,
        color: textColor || C.ink,
      },
      label
    )
  );
}

// Round avatar: white ring + ink outline + hard shadow. `uri` null → initial.
function avatar(uri, size, name) {
  const ring = Math.max(5, Math.round(size * 0.04));
  const white = Math.max(6, Math.round(size * 0.045));
  const inner = size - (ring + white) * 2;
  return h(
    "div",
    { position: "relative", width: size, height: size },
    h("div", { position: "absolute", left: 7, top: 9, width: size, height: size, borderRadius: size, backgroundColor: C.ink }),
    h(
      "div",
      {
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        borderRadius: size,
        backgroundColor: C.white,
        border: `${ring}px solid ${C.ink}`,
        alignItems: "center",
        justifyContent: "center",
      },
      uri
        ? h("img", { src: uri, width: inner, height: inner, borderRadius: inner })
        : h(
            "div",
            {
              width: inner,
              height: inner,
              borderRadius: inner,
              backgroundColor: C.pink,
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Fredoka",
              fontSize: Math.round(size * 0.42),
              color: C.ink,
            },
            latin(name, "C").slice(0, 1).toUpperCase()
          )
    )
  );
}

// Progress bar: ink-outlined track, striped fill.
function bar(width, ratio, height, color, stripe) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const hgt = height || 30;
  const fill = Math.round((width - 8) * r);
  return h(
    "div",
    {
      width,
      height: hgt,
      borderRadius: hgt,
      backgroundColor: C.creamDark,
      border: `4px solid ${C.ink}`,
      overflow: "hidden",
    },
    fill > 0
      ? h("div", {
          width: Math.max(hgt - 8, fill),
          height: hgt - 8,
          borderRadius: hgt,
          backgroundColor: color,
          backgroundImage: `repeating-linear-gradient(-45deg, ${color} 0px, ${color} 12px, ${stripe} 12px, ${stripe} 24px)`,
          border: `2px solid ${C.ink}`,
        })
      : null
  );
}

// Numbered cube + label (the welcome checklist).
function step(n, label, color) {
  return h(
    "div",
    { alignItems: "center", marginRight: 18 },
    h(
      "div",
      {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: color,
        border: `4px solid ${C.ink}`,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Fredoka",
        fontSize: 22,
        color: C.ink,
        marginRight: 10,
        transform: "rotate(-6deg)",
      },
      String(n)
    ),
    txt(label, { fontFamily: "Fredoka", fontSize: 22, color: C.ink })
  );
}

const at = (x, y, node, extra) => h("div", { position: "absolute", left: x, top: y, ...(extra || {}) }, node);

// ── Welcome card (1200 × 500) ────────────────────────────────────────────────

async function welcome(d) {
  const W = 1200;
  const H = 500;
  const [av, icon] = await Promise.all([dataUri(d.avatarUrl), dataUri(d.gameIconUrl)]);
  const name = clip(latin(d.name, d.username), 16);
  const nameSize = name.length > 12 ? 44 : name.length > 8 ? 52 : 60;
  const joined = d.joinedAt
    ? new Date(d.joinedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  const tree = backdrop(
    W,
    H,
    C.purple,
    C.purpleStripe,
    [
      panel(
        40,
        40,
        W - 80,
        H - 80,
        { padding: 30, alignItems: "center" },
        // Left: avatar + member sticker. Panel inner width ~1050: left 240 +
        // gap 30 + middle 560 + gap 16 + right 190.
        h(
          "div",
          { position: "relative", width: 240, height: 300, alignItems: "center", justifyContent: "center" },
          avatar(av, 216, name),
          at(22, 236, sticker(`MEMBER #${fmt(d.memberNumber)}`, C.gold, -6, { fontSize: 20 }))
        ),
        // Middle: copy
        h(
          "div",
          { flexDirection: "column", width: 560, marginLeft: 30, marginRight: 16, justifyContent: "center" },
          big("WELCOME!", 80, C.gold),
          txt(name, { fontFamily: "Fredoka", fontSize: nameSize, color: C.ink, marginTop: 8, lineHeight: 1.05 }),
          txt(`@${latin(d.username, "cube")}${joined ? `  ·  joined ${joined}` : ""}`, {
            fontSize: 22,
            fontWeight: 700,
            color: C.inkSoft,
            marginTop: 2,
          }),
          h("div", { height: 5, borderRadius: 5, backgroundColor: C.ink, opacity: 0.12, marginTop: 22, marginBottom: 20, width: 540 }),
          h("div", { alignItems: "center" }, step(1, "Link your Roblox", C.gold), step(2, "Grab your code", C.pink), step(3, "Say hi", C.teal))
        ),
        // Right: the game, polaroid-style
        h(
          "div",
          { position: "relative", width: 190, height: 300, alignItems: "center", justifyContent: "center", flexDirection: "column", flexShrink: 0 },
          h(
            "div",
            { position: "relative", width: 150, height: 150, transform: "rotate(5deg)" },
            h("div", { position: "absolute", left: 6, top: 8, width: 150, height: 150, borderRadius: 22, backgroundColor: C.ink }),
            h(
              "div",
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: 150,
                height: 150,
                borderRadius: 22,
                backgroundColor: C.white,
                border: `5px solid ${C.ink}`,
                padding: 8,
              },
              icon
                ? h("img", { src: icon, width: 124, height: 124, borderRadius: 14 })
                : h("div", { width: 124, height: 124, borderRadius: 14, backgroundColor: C.pink })
            )
          ),
          txt("ROLL A CUBE", { fontFamily: "Fredoka", fontSize: 24, color: C.ink, marginTop: 24 }),
          txt(`${fmt(d.memberCount)} members`, { fontSize: 19, fontWeight: 800, color: C.inkSoft, marginTop: 2 }),
          d.updateLabel ? at(24, 280, sticker(latin(d.updateLabel, ""), C.teal, 4, { fontSize: 15 })) : null
        )
      ),
    ],
    [
      cubeFace(W - 150, -30, 130, C.gold, 14),
      cubeFace(-40, H - 120, 120, C.pink, -12),
      cubeFace(W * 0.42, H - 62, 64, C.teal, 8, "wow"),
      cubeFace(W - 70, H - 90, 58, C.orange, -18),
    ]
  );

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
  const barW = 470;

  const tree = backdrop(
    W,
    H,
    C.teal,
    C.tealStripe,
    [
      panel(
        30,
        30,
        W - 60,
        H - 60,
        { padding: 30, alignItems: "center" },
        avatar(av, 176, name),
        h(
          "div",
          { flexDirection: "column", width: 488, marginLeft: 34, justifyContent: "center" },
          h(
            "div",
            { alignItems: "flex-end" },
            txt(name, { fontFamily: "Fredoka", fontSize: name.length > 10 ? 40 : 50, lineHeight: 1, color: C.ink }),
            txt(`@${latin(d.username, "cube")}`, { fontSize: 20, fontWeight: 800, color: C.inkSoft, marginLeft: 12, marginBottom: 4 })
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
                    backgroundColor: C.white,
                    border: `4px solid ${C.ink}`,
                    paddingLeft: 6,
                    paddingRight: 14,
                    paddingTop: 4,
                    paddingBottom: 4,
                  },
                  head
                    ? h("img", { src: head, width: 30, height: 30, borderRadius: 30, marginRight: 8 })
                    : h("div", { width: 30, height: 30, borderRadius: 30, backgroundColor: C.pink, marginRight: 8 }),
                  txt(`@${latin(d.robloxName, "linked")} linked`, { fontFamily: "Fredoka", fontSize: 18, color: C.ink })
                )
              : sticker("NOT LINKED · grab a code in #codes", C.orange, 0, { fontSize: 15 }),
            txt(`${fmt(d.messages)} messages`, { fontSize: 19, fontWeight: 800, color: C.inkSoft, marginLeft: 18 })
          ),
          h("div", { marginTop: 24 }, bar(barW, inLevel / need, 30, C.gold, C.goldStripe)),
          h(
            "div",
            { justifyContent: "space-between", width: barW, marginTop: 8 },
            txt(`${fmt(inLevel)} / ${fmt(need)} XP`, { fontFamily: "Fredoka", fontSize: 19, color: C.ink }),
            txt(`${fmt(need - inLevel)} XP to level ${fmt((d.level || 0) + 1)}`, { fontSize: 18, fontWeight: 700, color: C.inkFaint })
          )
        ),
        h(
          "div",
          { flexDirection: "column", alignItems: "center", justifyContent: "center", width: 180, flexShrink: 0 },
          txt("LEVEL", { fontFamily: "Fredoka", fontSize: 22, letterSpacing: 3, color: C.ink }),
          big(String(d.level || 0), 108, C.gold, { marginTop: 2 }),
          h("div", { marginTop: 14 }, sticker(`RANK #${fmt(d.rank)}`, C.pink, -4, { fontSize: 18 }))
        )
      ),
    ],
    [cubeFace(W - 96, -26, 86, C.gold, 16), cubeFace(-30, H - 74, 78, C.pink, -10), cubeFace(W * 0.5, H - 40, 50, C.purple, 10, "wow")]
  );

  return raster(tree, W, H);
}

// ── Level-up card (1000 × 380) ───────────────────────────────────────────────

async function levelup(d) {
  const W = 1000;
  const H = 380;
  const av = await dataUri(d.avatarUrl);
  const name = clip(latin(d.name, d.username), 16);

  // Burst behind the avatar: flat spokes (Satori rotates around the centre).
  const cx = 160;
  const cy = H / 2;
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const len = i % 2 === 0 ? 168 : 140;
    rays.push(
      h("div", {
        position: "absolute",
        left: cx - len,
        top: cy - 5,
        width: len * 2,
        height: 10,
        borderRadius: 10,
        backgroundColor: i % 2 === 0 ? C.white : C.ink,
        opacity: i % 2 === 0 ? 0.9 : 0.75,
        transform: `rotate(${i * 22.5}deg)`,
      })
    );
  }

  const tree = backdrop(
    W,
    H,
    C.gold,
    C.goldStripe,
    [
      ...rays,
      at(70, (H - 180) / 2, avatar(av, 180, name)),
      panel(
        300,
        46,
        W - 300 - 40,
        H - 92,
        { padding: 32, flexDirection: "column", justifyContent: "center" },
        big("LEVEL UP!", 74, C.pink),
        h(
          "div",
          { alignItems: "flex-end", marginTop: 12 },
          txt(name, { fontFamily: "Fredoka", fontSize: 40, lineHeight: 1, color: C.ink }),
          txt("is now level", { fontSize: 24, fontWeight: 800, color: C.inkSoft, marginLeft: 12, marginBottom: 3 }),
          big(String(d.level || 1), 60, C.gold, { marginLeft: 14 })
        ),
        h("div", { height: 5, borderRadius: 5, backgroundColor: C.ink, opacity: 0.12, marginTop: 20, marginBottom: 16, width: 520 }),
        d.rewardLabel
          ? h(
              "div",
              { alignItems: "center" },
              sticker("REWARD UNLOCKED", C.teal, -3, { fontSize: 15 }),
              txt(clip(latin(d.rewardLabel, ""), 42), { fontFamily: "Fredoka", fontSize: 24, marginLeft: 18, color: C.ink })
            )
          : txt(d.nextRewardLevel ? `Next in-game reward at level ${d.nextRewardLevel}` : "Keep chatting to climb the board", {
              fontSize: 22,
              fontWeight: 800,
              color: C.inkSoft,
            })
      ),
    ],
    [cubeFace(W - 90, -24, 84, C.pink, 12, "wow"), cubeFace(-26, H - 70, 70, C.teal, -14), cubeFace(W - 120, H - 66, 56, C.purple, -8)]
  );

  return raster(tree, W, H);
}

// ── Leaderboard (1000 × dynamic) ─────────────────────────────────────────────

async function leaderboard(d) {
  const rows = (d.rows || []).slice(0, 10);
  const W = 1000;
  const ROW = 62;
  const H = 150 + rows.length * (ROW + 6) + 56;
  const avatars = await Promise.all(rows.map((r) => dataUri(r.avatarUrl)));
  const medal = [C.gold, "#d9dde6", "#e0a370"];

  const tree = backdrop(
    W,
    H,
    C.purple,
    C.purpleStripe,
    [
      panel(
        30,
        30,
        W - 60,
        H - 60,
        { padding: 26, flexDirection: "column" },
        h(
          "div",
          { alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16, paddingLeft: 6 },
          h(
            "div",
            { alignItems: "flex-end" },
            big("TOP CUBES", 46, C.gold),
            txt(`${fmt(d.total)} ranked`, { fontSize: 18, fontWeight: 800, color: C.inkSoft, marginLeft: 16, marginBottom: 4 })
          ),
          txt("chat to earn XP · linked accounts get in-game rewards", { fontSize: 15, fontWeight: 700, color: C.inkFaint, marginBottom: 6 })
        ),
        ...rows.map((r, i) =>
          h(
            "div",
            {
              alignItems: "center",
              height: ROW,
              borderRadius: 16,
              paddingLeft: 12,
              paddingRight: 18,
              marginBottom: 6,
              backgroundColor: i < 3 ? C.white : i % 2 ? C.creamDark : "rgba(0,0,0,0)",
              border: i < 3 ? `4px solid ${C.ink}` : "4px solid rgba(0,0,0,0)",
            },
            h(
              "div",
              {
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: medal[i] || C.creamDark,
                border: `4px solid ${C.ink}`,
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "Fredoka",
                fontSize: 20,
                color: C.ink,
                marginRight: 14,
                transform: `rotate(${i < 3 ? -6 : 0}deg)`,
              },
              String(r.rank)
            ),
            h(
              "div",
              { width: 44, height: 44, borderRadius: 44, border: `3px solid ${C.ink}`, backgroundColor: C.pink, marginRight: 14, overflow: "hidden" },
              avatars[i] ? h("img", { src: avatars[i], width: 38, height: 38, borderRadius: 38 }) : null
            ),
            txt(clip(latin(r.name, r.username), 24), { fontFamily: "Fredoka", fontSize: 26, flexGrow: 1, color: C.ink }),
            sticker(`LVL ${r.level}`, C.pink, 0, { fontSize: 14, marginRight: 18 }),
            txt(`${fmt(r.xp)} XP`, { fontSize: 20, fontWeight: 800, color: C.inkSoft, width: 140, justifyContent: "flex-end" })
          )
        ),
        rows.length === 0
          ? txt("Nobody has XP yet - say something!", { fontFamily: "Fredoka", fontSize: 24, color: C.inkSoft, marginTop: 10 })
          : null
      ),
    ],
    [cubeFace(W - 92, -26, 86, C.gold, 14), cubeFace(-28, H - 76, 78, C.teal, -12, "wow")]
  );

  return raster(tree, W, H);
}

// ── Rules header (1200 × 380) ────────────────────────────────────────────────

async function rules(d) {
  const W = 1200;
  const H = 380;
  const count = Number(d.count || 0);
  const chip = (label, color, rot) => h("div", { marginRight: 16 }, sticker(label, color, rot, { fontSize: 18 }));

  const tree = backdrop(
    W,
    H,
    C.purple,
    C.purpleStripe,
    [
      panel(
        40,
        40,
        W - 80,
        H - 80,
        { padding: 34, alignItems: "center" },
        // Left: a stack of "law" cubes.
        h(
          "div",
          { position: "relative", width: 250, height: 260 },
          cubeFace(20, 120, 120, C.gold, -8),
          cubeFace(120, 60, 96, C.pink, 12, "wow"),
          cubeFace(60, 10, 70, C.teal, -18)
        ),
        h(
          "div",
          { flexDirection: "column", width: 620, marginLeft: 24, marginRight: 8, justifyContent: "center" },
          big("SERVER RULES", 78, C.gold),
          txt("Roll A Cube  ·  read these before you post", {
            fontFamily: "Fredoka",
            fontSize: 28,
            color: C.ink,
            marginTop: 10,
          }),
          h("div", { height: 5, borderRadius: 5, backgroundColor: C.ink, opacity: 0.12, marginTop: 22, marginBottom: 22, width: 580 }),
          h("div", { alignItems: "center" }, chip("BE COOL", C.teal, -3), chip("PLAY FAIR", C.pink, 2), chip("HAVE FUN", C.gold, -2))
        ),
        h(
          "div",
          { position: "relative", width: 150, height: 260, alignItems: "center", justifyContent: "center", flexShrink: 0 },
          h(
            "div",
            { flexDirection: "column", alignItems: "center" },
            big(String(count), 110, C.white),
            txt("RULES", { fontFamily: "Fredoka", fontSize: 26, letterSpacing: 4, color: C.ink, marginTop: 4 })
          )
        )
      ),
    ],
    [cubeFace(W - 96, -28, 90, C.orange, 14), cubeFace(-30, H - 80, 84, C.teal, -12, "wow"), cubeFace(W * 0.55, H - 46, 54, C.pink, 8)]
  );

  return raster(tree, W, H);
}

// ── Icon (160 × 160, transparent): one cube mascot, used as a thumbnail ──────

async function icon(d) {
  const S = 160;
  const colors = { gold: C.gold, pink: C.pink, teal: C.teal, purple: C.purple, orange: C.orange };
  const color = colors[d.color] || C.gold;
  const size = 112;
  const off = (S - size) / 2;
  const tree = h(
    "div",
    { width: S, height: S, position: "relative" },
    h("div", { position: "absolute", left: off + 8, top: off + 10, width: size, height: size, borderRadius: Math.round(size * 0.2), backgroundColor: C.ink, transform: `rotate(${d.rot || -8}deg)` }),
    cubeFace(off, off, size, color, d.rot || -8, d.mood)
  );
  return raster(tree, S, S);
}

// ── Raster ───────────────────────────────────────────────────────────────────

async function raster(tree, width, height) {
  await ensureWasm();
  const svg = await satori(tree, { width, height, fonts: FONTS });
  if (process.env.CARD_DEBUG_SVG) fs.writeFileSync(process.env.CARD_DEBUG_SVG, svg);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return Buffer.from(png);
}

const KINDS = { welcome, rank, levelup, leaderboard, rules, icon };

async function render(kind, data) {
  const fn = KINDS[kind];
  if (!fn) throw new Error(`unknown card kind: ${kind}`);
  return fn(data || {});
}

module.exports = { render, KINDS: Object.keys(KINDS) };
