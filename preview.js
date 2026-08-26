// Local preview: `node preview.js [outDir]` writes one PNG per card kind with
// sample data so the designs can be eyeballed without touching Discord.
const fs = require("fs");
const path = require("path");
const { render } = require("./render");

const out = process.argv[2] || path.join(__dirname, "preview-out");
fs.mkdirSync(out, { recursive: true });

const AVATAR = "https://cdn.discordapp.com/embed/avatars/3.png";
const HEAD = "https://tr.rbxcdn.com/30DAY-AvatarHeadshot-8B7E1D8B6B0B0C1B1C1B1C1B1C1B1C1B-Png/420/420/AvatarHeadshot/Png/noFilter";

const samples = {
  welcome: {
    name: "ℓʏ' ✧ 𝓵𝓲𝔂𝓾",
    username: "lieeyui",
    avatarUrl: AVATAR,
    memberNumber: 1284,
    joinedAt: Date.now(),
    memberCount: 1284,
    updateLabel: "UPDATE 1 LIVE",
    gameIconUrl: null,
  },
  rank: {
    name: "liyu",
    username: "lieeyui",
    avatarUrl: AVATAR,
    level: 12,
    rank: 4,
    xp: 8120,
    xpInLevel: 1250,
    xpForLevel: 2400,
    messages: 341,
    robloxName: "jihi",
    robloxHeadshotUrl: HEAD,
  },
  levelup: {
    name: "liyu",
    username: "lieeyui",
    avatarUrl: AVATAR,
    level: 5,
    rewardLabel: "2x Luck potion (in game)",
  },
  leaderboard: {
    total: 57,
    rows: Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      name: ["liyu", "Luca", "OutDeg", "DuperTester", "CubeFan99", "xX_Roller_Xx", "meteor girl", "pixel", "nova", "sam"][i],
      username: "user" + i,
      avatarUrl: `https://cdn.discordapp.com/embed/avatars/${i % 6}.png`,
      level: 30 - i * 2,
      xp: 90000 - i * 7000,
    })),
  },
};

(async () => {
  for (const [kind, data] of Object.entries(samples)) {
    const t0 = Date.now();
    const png = await render(kind, data);
    const file = path.join(out, `${kind}.png`);
    fs.writeFileSync(file, png);
    console.log(`${kind}: ${png.length} bytes in ${Date.now() - t0}ms -> ${file}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
