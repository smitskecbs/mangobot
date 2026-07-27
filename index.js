require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");

const POINTS_FILE = path.join(__dirname, "points.json");

const TRIGGERS = {
  gmango: 2,
  gnango: 2,
  gm: 1,
  gn: 1,
};

function loadPoints() {
  try {
    if (!fs.existsSync(POINTS_FILE)) {
      return { users: {} };
    }

    const raw = fs.readFileSync(POINTS_FILE, "utf8").trim();
    if (!raw) {
      console.error("points.json is empty, resetting...");
      const fresh = { users: {} };
      savePoints(fresh);
      return fresh;
    }

    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
      console.error("points.json has invalid structure, resetting...");
      const fresh = { users: {} };
      savePoints(fresh);
      return fresh;
    }

    return data;
  } catch (err) {
    console.error("Error loading points.json:", err);
    const fresh = { users: {} };
    try {
      savePoints(fresh);
    } catch (saveErr) {
      console.error("Error resetting points.json:", saveErr);
    }
    return fresh;
  }
}

function savePoints(data) {
  try {
    fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving points.json:", err);
  }
}

function ensurePointsFile() {
  if (!fs.existsSync(POINTS_FILE)) {
    savePoints({ users: {} });
  }
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getWeekId(date = new Date()) {
  const now = new Date(date);
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

function isAdmin(userId) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return false;
  return String(userId) === String(adminId);
}

function getRank(points) {
  if (points >= 500) return { emoji: "👑", title: "Mango Guardian" };
  if (points >= 250) return { emoji: "🥭", title: "Mango Legend" };
  if (points >= 100) return { emoji: "🌳", title: "Mango Tree" };
  if (points >= 25) return { emoji: "🌿", title: "Mango Sprout" };
  return { emoji: "🌱", title: "Mango Seed" };
}

function getTriggersClaimedToday(user) {
  if (user.triggerDate !== getTodayDate()) {
    return [];
  }
  return user.triggersUsed || [];
}

function getUserRecord(data, userId) {
  return (
    data.users[String(userId)] || {
      points: 0,
      weeklyPoints: 0,
      weekId: null,
      name: "Unknown",
      triggerDate: null,
      triggersUsed: [],
    }
  );
}

function resetWeeklyIfNewWeek(user) {
  const currentWeek = getWeekId();
  if (user.weekId !== currentWeek) {
    user.weekId = currentWeek;
    user.weeklyPoints = 0;
  }
  if (user.weeklyPoints === undefined) {
    user.weeklyPoints = 0;
  }
  if (user.weekId === undefined) {
    user.weekId = currentWeek;
  }
}

function getEffectiveWeeklyPoints(user) {
  if (user.weekId !== getWeekId()) {
    return 0;
  }
  return user.weeklyPoints || 0;
}

function resetTriggersIfNewDay(user) {
  const today = getTodayDate();
  if (user.triggerDate !== today) {
    user.triggerDate = today;
    user.triggersUsed = [];
  }
}

function awardTriggerPoints(userId, userName, trigger) {
  const data = loadPoints();
  const id = String(userId);
  const pointsToAdd = TRIGGERS[trigger];

  if (!data.users[id]) {
    data.users[id] = {
      points: 0,
      weeklyPoints: 0,
      weekId: getWeekId(),
      name: userName,
      triggerDate: getTodayDate(),
      triggersUsed: [],
    };
  }

  const user = data.users[id];
  user.name = userName;
  resetTriggersIfNewDay(user);
  resetWeeklyIfNewWeek(user);

  if (user.triggersUsed.includes(trigger)) {
    return { awarded: false, points: user.points, pointsToAdd };
  }

  user.points += pointsToAdd;
  user.weeklyPoints += pointsToAdd;
  user.triggersUsed.push(trigger);
  savePoints(data);
  return { awarded: true, points: user.points, pointsToAdd };
}

ensurePointsFile();

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("🥭 Welcome to ManGo Bot!\n\nType /help for commands.");
});

bot.help((ctx) => {
  ctx.reply(`🥭 Commands

/about
/community
/launch
/links
/points
/leaderboard
/weekly
/rules
/help`);
});

bot.command("about", (ctx) => {
  ctx.reply(
    "🥭 ManGo is a community meme project built in public using the CBS tools ecosystem."
  );
});

bot.command("community", (ctx) => {
  ctx.reply(`🥭 ManGo Community

ManGo is a community-driven meme project built in public.

No fake promises.
No paid hype.
No launch pressure.

Just building, learning and having fun together.`);
});

bot.command("launch", (ctx) => {
  ctx.reply(`🥭 Launch Status

ManGo is still building.

Our bags are slowly filling to prepare the future liquidity pool while the community continues to grow.

No presale.
No public CA.
No launch date.

We're building first.
Launching later.`);
});

bot.command("links", (ctx) => {
  ctx.reply(`🥭 Official ManGo Links

🌐 Website
https://mangomeme.fun

🐦 X
https://x.com/ManGomemefun

💬 Telegram
https://t.me/mangomeme

📱 WhatsApp
https://chat.whatsapp.com/HYuIoFGtvB20c5oHgI4Lcs

📘 Facebook
https://www.facebook.com/profile.php?id=61590572230511

🛠 CBS Tools
https://tools.cbs-coin.com

💻 GitHub
https://github.com/smitskecbs`);
});

bot.command("rules", (ctx) => {
  ctx.reply(`🥭 Rules

1. No spam
2. No scams
3. No paid promo
4. Respect everyone`);
});

bot.command("points", (ctx) => {
  const data = loadPoints();
  const user = getUserRecord(data, ctx.from.id);
  const name = ctx.from.first_name || "friend";
  const rank = getRank(user.points);
  const weeklyPoints = getEffectiveWeeklyPoints(user);
  const claimedToday = getTriggersClaimedToday(user);
  const claimedText = claimedToday.length > 0 ? claimedToday.join(", ") : "none";
  const lifetimeLabel = user.points === 1 ? "point" : "points";
  const weeklyLabel = weeklyPoints === 1 ? "point" : "points";

  ctx.reply(`🥭 ${name}

Lifetime points: ${user.points} ${lifetimeLabel}
Weekly points: ${weeklyPoints} ${weeklyLabel}
Rank: ${rank.emoji} ${rank.title}

Claimed today: ${claimedText}`);
});

bot.command("leaderboard", (ctx) => {
  const data = loadPoints();
  const top = Object.values(data.users)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (top.length === 0) {
    ctx.reply(
      "🥭 Leaderboard is empty. Type gmango, gnango, gm or gn to earn points!"
    );
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((user, index) => {
    const prefix = medals[index] || `${index + 1}.`;
    const rank = getRank(user.points);
    return `${prefix} ${user.name} — ${user.points} pts ${rank.emoji}`;
  });

  ctx.reply(`🥭 ManGo Leaderboard — Top 10\n\n${lines.join("\n")}`);
});

bot.command("weekly", (ctx) => {
  const data = loadPoints();
  const top = Object.values(data.users)
    .map((user) => ({ ...user, weeklyPoints: getEffectiveWeeklyPoints(user) }))
    .filter((user) => user.weeklyPoints > 0)
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints)
    .slice(0, 10);

  if (top.length === 0) {
    ctx.reply(
      "🥭 Weekly leaderboard is empty. Type gmango, gnango, gm or gn to earn points!"
    );
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((user, index) => {
    const prefix = medals[index] || `${index + 1}.`;
    return `${prefix} ${user.name} — ${user.weeklyPoints} pts`;
  });

  ctx.reply(`🥭 Weekly ManGo Leaders\n\n${lines.join("\n")}`);
});

bot.command("resetweekly", (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    ctx.reply("This command is admin only.");
    return;
  }

  const data = loadPoints();
  const currentWeek = getWeekId();

  for (const user of Object.values(data.users)) {
    user.weeklyPoints = 0;
    user.weekId = currentWeek;
  }

  savePoints(data);
  ctx.reply("🥭 Weekly points reset for all users.");
});

bot.on("text", (ctx) => {
  const text = ctx.message.text.trim().toLowerCase();
  const pointsToAdd = TRIGGERS[text];

  if (pointsToAdd === undefined) {
    return;
  }

  const userName = ctx.from.first_name || ctx.from.username || "friend";
  const result = awardTriggerPoints(ctx.from.id, userName, text);

  if (!result.awarded) {
    ctx.reply("🥭 Already claimed today. Try another ManGo trigger!");
  }
});

bot.on("new_chat_members", (ctx) => {
  const members = ctx.message.new_chat_members;

  members.forEach((member) => {
    const name = member.first_name || "friend";

    ctx.reply(`🥭 Welcome ${name}!

Welcome to the ManGo community.

📌 Please read the pinned message
🌐 Use /links for official links
🚀 Use /launch for project status

Enjoy the build!`);
  });
});

bot.launch();

console.log("🥭 ManGo Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));