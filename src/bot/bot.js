// The remote control: a normal Discord bot. Never touches voice; tells the player what
// to do over local HTTP. Every message it posts is a fixed template filled with real
// metadata (no AI-written text).
//
// It shares its login with coupbot. Coup uses only "!coup" text commands, so there's no
// clash, but to stay safe: commands are added one at a time (never a bulk overwrite
// that would wipe someone else's), and interactions that aren't ours are ignored.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { config, secrets } from "../config.js";
import { log } from "../log.js";
import { PLAYER_URL, callPlayer, localSecret } from "../local.js";
import { runSync } from "../catalog/index.js";
import { setEntrance, clearEntrance } from "./entrance.js";
import { generateSchedule } from "../schedule/generate.js";
import { planSpecials } from "../schedule/specials.js";
import { addFromUrls, addFromFiles } from "../catalog/download.js";
import { localDay, localTime } from "../schedule/time.js";
import { scheduledUntil } from "../schedule/store.js";
import { weekGrid, dayGuide } from "../schedule/guide.js";
import { runTagging } from "../tagging/tagger.js";
import { tagOrder } from "../tagging/order.js";
import { tagEpisodeThemes } from "../tagging/episodes.js";
import { tagBreaks } from "../tagging/breaks.js";
import { getMeta, setMeta, getDb } from "../db.js";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

export const RESTART_FLAG = join(DATA_DIR, "restart-bot");

// One background job at a time (sync, tagging, scheduling all write the catalog).
const maintenance = {
  busy: Promise.resolve(),
  pending: 0, // jobs running or waiting
  run(fn) {
    this.pending++;
    const job = this.busy.then(fn).finally(() => this.pending--);
    this.busy = job.catch(() => {});
    return job;
  },
};

// Weekly catalog sync + tagging of anything new; keep at least 2 days scheduled.
async function upkeep() {
  const week = 7 * 86400000;
  const lastSync = Date.parse(getMeta("last_sync") || 0) || 0;
  if (Date.now() - lastSync > week) {
    log.info("bot: weekly catalog sync");
    // A failed sync (a drive dropping out mid-scan) mustn't stop the schedule top-up below.
    await runSync().catch((e) => log.error("bot: catalog sync failed:", e.message));
    await runTagging().catch((e) => log.warn(`bot: tagging failed: ${e.message}`));
    await tagOrder().catch((e) => log.warn(`bot: order tagging failed: ${e.message}`));
    await tagEpisodeThemes().catch((e) => log.warn(`bot: episode theme tagging failed: ${e.message}`));
    await tagBreaks().catch((e) => log.warn(`bot: TV-break tagging failed: ${e.message}`));
  }
  const until = scheduledUntil();
  if (until < Date.now() + 12 * 3600000) {
    log.info(`bot: programming the next ${config.broadcast.plan_days} day(s)`);
    await generateSchedule({ fromMs: until, days: config.broadcast.plan_days });
  }
  // The automatic weekly special(s), if none is coming up yet.
  const want = config.broadcast.specials_per_week;
  const upcoming = getDb().prepare("SELECT COUNT(DISTINCT label) n FROM blocks WHERE source = 'special' AND start_at > ?").get(Date.now()).n;
  if (want > 0 && upcoming === 0) {
    log.info("bot: planning this week's special");
    await planSpecials({ count: want, days: 7 }).catch((e) => log.warn(`bot: special planning failed: ${e.message}`));
  }
}

const guildId = () => config.discord.guild_id || process.env.GUILD_ID;
const ephemeral = { flags: MessageFlags.Ephemeral };

// Days of guide lines ([{title, lines}]) as embeds, packed into as few messages as fit.
// Discord: 4096 characters per embed; 6000 and 10 embeds per message. A day too long
// for one embed carries on in the next.
export function guideMessages(days) {
  const embeds = [];
  for (const d of days) {
    let text = "";
    let part = 0;
    const flush = () => {
      embeds.push(new EmbedBuilder().setTitle(part++ ? `${d.title} (continued)` : d.title).setDescription(text));
      text = "";
    };
    for (const l of d.lines) {
      if (text && text.length + l.length + 1 > 4000) flush();
      text += `${text ? "\n" : ""}${l.slice(0, 4000)}`;
    }
    if (text) flush();
  }
  const messages = [[]];
  let used = 0;
  for (const e of embeds) {
    const size = e.data.title.length + e.data.description.length;
    if ((used + size > 5800 || messages.at(-1).length === 10) && messages.at(-1).length) { messages.push([]); used = 0; }
    messages.at(-1).push(e);
    used += size;
  }
  return messages;
}

const ANYONE_ADMIN = String(config.discord.admin_user_id).trim() === "*";

// /tvhelp: how to use the TV, for everyone (posted in the channel, not private).
function helpEmbeds() {
  const thread = (id, name) => (id ? `<#${id}>` : `the ${name} thread`);
  const d = config.discord;
  return [
    new EmbedBuilder().setTitle("📺 How to use the TV").setDescription([
      "**Watch**",
      "• Join a voice channel and type `/tv`. The TV joins and starts whatever the schedule says is on right now, like real TV.",
      "• Click **Watch** on the stream in the voice channel to see it (after the TV restarts, click it again).",
      "• `/tvoff` turns it off. It also leaves by itself when nobody's watching.",
      "",
      "**Pause and catch up** (people in the TV's voice channel)",
      "• `/tvpause` or the **Pause** button: freezes it on a \"Paused\" card. `/tvresume` picks up at the same second, and the TV catches up by cutting ads.",
      "• `/tvlive`: skip the catch-up and jump to what's on now.",
      "• **Skip commercials** button (on the break message): ends the current break.",
      "",
      "**What's on**",
      "• The **Today on TV** post in this channel has the day's lineup; it updates itself at midnight.",
      "• `/schedule` refreshes it (no new post, nobody gets pinged). `/schedule week: True` shows you the week's lineup privately.",
      "• Weekday nights have themes (heists and spies Monday, sci-fi Tuesday, whodunits and classics Wednesday, prestige and musicals Thursday, blockbusters Friday); Saturday mornings are cartoons, 5:30 to 12:15.",
    ].join("\n")),
    new EmbedBuilder().setTitle("🎬 Add stuff").setDescription([
      `• ${thread(d.drop_thread_id, "Commercials")}: post YouTube links or video files and they become **commercials**.`,
      `• ${thread(d.clip_thread_id, "Clips")}: same, as **clips** (short bits between shows).`,
      `• ${thread(d.eyecatch_thread_id, "Eyecatchers")}: same, as **eyecatches** (the little bumpers around a mid-show break; a minute at most).`,
      "The bot reacts ⏳, then ✅ or ⚠️ with a reply saying what went in or why not (too long, unavailable...). Commercials and clips can be up to 10 minutes. New ones can air at the next break.",
      "",
      "**Your entrance sound**",
      `• \`/entrance set\` with a sound or video file: it plays when you join the TV's voice channel (first ${config.entrance.max_seconds} seconds). \`/entrance clear\` removes it.`,
    ].join("\n")),
    new EmbedBuilder().setTitle(ANYONE_ADMIN ? "🛠️ Controls (anyone can use these for now)" : "🛠️ Admin controls").setDescription([
      "• `/tvadmin skip`: skip this episode or movie.",
      "• `/tvadmin skipblock`: skip the rest of this block.",
      "• `/tvadmin special`: plan a marathon or themed special, e.g. \"Scream marathon Saturday 8pm\".",
      "• `/tvadmin regen`: new random picks for the upcoming blocks.",
      "• `/tvadmin sync`: re-read the whole catalog now (takes a few minutes).",
      "• `/tvadmin add`: add commercials or clips by link (the threads above are easier).",
    ].join("\n")),
  ];
}

const COMMANDS = [
  new SlashCommandBuilder().setName("tv").setDescription("Turn on the TV in the voice channel you're in"),
  new SlashCommandBuilder().setName("tvoff").setDescription("Turn off the TV"),
  new SlashCommandBuilder().setName("tvpause").setDescription("Emergency pause: stop the picture and sound right now"),
  new SlashCommandBuilder().setName("tvresume").setDescription("Pick up where it was paused"),
  new SlashCommandBuilder().setName("tvlive").setDescription("Jump back to what the schedule says is on right now"),
  new SlashCommandBuilder().setName("tvadmin").setDescription("TV admin controls")
    // admin_user_id "*": anyone may use it, so don't hide it from people without Manage Server.
    .setDefaultMemberPermissions(ANYONE_ADMIN ? null : PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("skip").setDescription("Skip this episode or movie (the block goes on with its next one)"))
    .addSubcommand((s) => s.setName("skipblock").setDescription("Skip the rest of this block (the next block starts at the next quarter hour)"))
    .addSubcommand((s) => s.setName("sync").setDescription("Re-read the Plex, local and Real-Debrid catalog now"))
    .addSubcommand((s) => s.setName("regen").setDescription("New random picks for the upcoming blocks (same lineup of block types)")
      .addBooleanOption((o) => o.setName("new_grid").setDescription("Also have Claude lay out a new week of block types")))
    .addSubcommand((s) => s.setName("add").setDescription("Download a commercial or clip (YouTube link etc.) into rotation")
      .addStringOption((o) => o.setName("kind").setDescription("What it is").setRequired(true)
        .addChoices({ name: "commercial", value: "commercial" }, { name: "clip", value: "clip" }))
      .addStringOption((o) => o.setName("urls").setDescription("One or more links, separated by spaces").setRequired(true)))
    .addSubcommand((s) => s.setName("special").setDescription("Plan a marathon or themed special")
      .addStringOption((o) => o.setName("request").setDescription('e.g. "Scream marathon Saturday 8pm" or "Ghibli afternoon Sunday"').setRequired(true))),
  new SlashCommandBuilder().setName("tvhelp").setDescription("Post how to use the TV (replaces the last help post)"),
  new SlashCommandBuilder().setName("schedule").setDescription("Refresh today's TV guide post in the TV channel")
    .addBooleanOption((o) => o.setName("week").setDescription("Show me the whole week's lineup of block types instead (only you see it)")),
  new SlashCommandBuilder().setName("entrance").setDescription("Your sound when you join the TV's voice channel")
    .addSubcommand((s) => s.setName("set").setDescription(`Upload a sound (only the first ${config.entrance.max_seconds} seconds play)`)
      .addAttachmentOption((o) => o.setName("file").setDescription("mp3, wav, ogg, or a video clip").setRequired(true)))
    .addSubcommand((s) => s.setName("clear").setDescription("Remove an entrance sound")
      .addUserOption((o) => o.setName("user").setDescription("Whose (admin only; default: yours)"))),
];

const label = (seg) => (seg ? `${seg.title}${seg.subtitle ? ` ${seg.subtitle}` : ""}` : "");

export async function startBot() {
  // Messages (and their text) only for the drop threads; without any, don't ask for them.
  // Thread id -> what its links become.
  const dropThreads = new Map([
    [String(config.discord.drop_thread_id || "").trim(), "commercial"],
    [String(config.discord.clip_thread_id || "").trim(), "clip"],
    [String(config.discord.eyecatch_thread_id || "").trim(), "eyecatch"],
  ].filter(([id]) => id));
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
  if (dropThreads.size) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const client = new Client({ intents });
  let playerStatus = { state: "off" };
  let breakMsg = null;
  let nowPlayingMsg = null; // only the latest one stays up
  let pausedMsg = null;

  const button = (id, text, style = ButtonStyle.Secondary) =>
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style));

  const remove = (m) => m?.delete().catch(() => {});
  const removeLater = (m, ms) => m && setTimeout(() => remove(m), ms).unref();

  async function registerCommands() {
    const rest = new REST().setToken(secrets.botToken);
    for (const c of COMMANDS) {
      // POST creates or updates this one command by name; other bots' commands on the
      // same application are left alone.
      await rest.post(Routes.applicationGuildCommands(client.application.id, guildId()), { body: c.toJSON() });
    }
    log.info(`bot: registered /${COMMANDS.map((c) => c.name).join(", /")}`);
  }

  async function post(channelId, content, extra = {}) {
    if (!channelId) return null;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    return ch?.isTextBased() ? ch.send({ content, allowedMentions: { parse: [] }, ...extra }).catch((e) => log.warn(`bot: post failed: ${e.message}`)) : null;
  }

  // Leftover TV posts from before a restart (only this bot's, only TV ones).
  async function cleanUpOldPosts() {
    const ch = await client.channels.fetch(config.discord.now_playing_channel_id).catch(() => null);
    if (!ch?.isTextBased()) return;
    const msgs = await ch.messages.fetch({ limit: 100 });
    const ours = msgs.filter((m) => m.author.id === client.user.id && /^(Now playing:|Commercial break|Commercials skipped by|TV paused|TV restarting)/.test(m.content));
    for (const m of ours.values()) await remove(m);
    if (ours.size) log.info(`bot: cleaned up ${ours.size} old TV posts`);
  }

  async function clearBreakMsg(text) {
    const m = breakMsg;
    breakMsg = null;
    if (!m) return;
    await (text ? m.edit({ content: text, components: [] }) : m.delete()).catch(() => {});
  }

  async function onPlayerEvent(e) {
    playerStatus = e.status;
    if (e.type === "break-start") {
      // The posting channel keeps one TV message: during a break it's this one.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tv:skip:${e.breakId}`).setLabel("Skip commercials").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("tv:pause").setLabel("Pause").setStyle(ButtonStyle.Secondary));
      const lines = ["Commercial break"];
      if (e.nextTitle) lines.push(`Up next: ${e.nextTitle}`);
      if (e.endsAt > Date.now() + 5000) lines.push(`Back <t:${Math.round(e.endsAt / 1000)}:R>`);
      const old = nowPlayingMsg;
      nowPlayingMsg = null;
      await clearBreakMsg();
      breakMsg = await post(config.discord.now_playing_channel_id, lines.join("\n"), { components: [row] });
      await remove(old);
    } else if (e.type === "break-end") {
      await clearBreakMsg();
    } else if (e.type === "off") {
      await clearBreakMsg();
      await remove(nowPlayingMsg);
      await remove(pausedMsg);
      nowPlayingMsg = pausedMsg = null;
    } else if (e.type === "show") {
      const lines = [`Now playing: ${label(e.show)}`];
      if (e.upNext) lines.push(`Up next: ${label(e.upNext)}`);
      const old = nowPlayingMsg;
      nowPlayingMsg = await post(config.discord.now_playing_channel_id, lines.join("\n"), { components: [button("tv:pause", "Pause")] });
      await remove(old);
    } else if (e.type === "paused") {
      await clearBreakMsg();
      await remove(nowPlayingMsg);
      nowPlayingMsg = null;
      pausedMsg ??= await post(config.discord.now_playing_channel_id, "TV paused", { components: [button("tv:resume", "Resume", ButtonStyle.Primary)] });
    } else if (e.type === "on") {
      await remove(pausedMsg);
      pausedMsg = null;
    } else if (e.type === "restarting") {
      await clearBreakMsg();
      removeLater(await post(config.discord.now_playing_channel_id, "TV restarting, back in about 20 seconds (click Watch again when it's back)"), 90000);
    } else if (e.type === "hello") {
      // Just (re)connected, and startup cleaned up the old post: say what's on now rather
      // than leave the channel blank until the next show starts. (In a break, the break
      // message comes with the next event.)
      const now = e.status?.now;
      if (e.status?.state === "on" && ["episode", "movie", "short"].includes(now?.kind) && !nowPlayingMsg) {
        nowPlayingMsg = await post(config.discord.now_playing_channel_id, `Now playing: ${label(now)}`, { components: [button("tv:pause", "Pause")] });
      }
    }
  }

  // Follow the player's event stream; reconnect whenever it restarts.
  // The whole day's programming, posted just after midnight. Upkeep only keeps about
  // 12 hours filled, so the rest of the day is programmed first. If the bot was down
  // at midnight it still posts in the first few hours; later than that it waits for
  // tomorrow rather than post a guide for a half-gone day.
  const guideChannel = () => config.discord.guide_channel_id || config.discord.now_playing_channel_id;
  const linkTo = (m) => `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.id}`;

  // Program the rest of today if it isn't yet (upkeep keeps only ~12 hours filled). Can
  // fail (nothing to plan from): then the guide shows what there is.
  async function fillToday() {
    const day = localDay(Date.now());
    await maintenance.run(async () => {
      const until = scheduledUntil();
      if (until < day.endMs) await generateSchedule({ fromMs: until, days: (day.endMs - until) / 86400000 });
    }).catch((e) => log.warn(`bot: couldn't program the rest of today for the guide: ${e.message}`));
  }

  // The TV channel keeps one guide post (one or more messages; ids in meta guide_post),
  // always updated by editing, which notifies nobody: a new message is posted only for a
  // part the post doesn't have yet (the day's guide got longer, or the post was deleted),
  // and parts no longer needed are deleted. Returns its first message, or null.
  async function publishGuide() {
    const channelId = guideChannel();
    const ch = channelId && await client.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased()) return null;
    const guide = dayGuide();
    const parts = guide.lines.length ? guideMessages([guide]) : [[]];
    const header = guide.lines.length ? "Today on TV (times shift a little as the day goes; /schedule refreshes this)" : "Nothing scheduled today.";
    const saved = JSON.parse(getMeta("guide_post") || "null");
    let old = [];
    if (saved?.channelId === channelId) {
      for (const id of saved.ids) { const m = await ch.messages.fetch(id).catch(() => null); if (m) old.push(m); }
    } else {
      // No record yet (guides posted before this was tracked): take over the newest guide
      // post (and its "continued" parts) and delete older ones.
      const recent = [...(await ch.messages.fetch({ limit: 100 }).catch(() => new Map())).values()]
        .filter((m) => m.author.id === client.user.id).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const isHead = (m) => m.content.startsWith("Today on TV") || m.content.startsWith("Nothing scheduled today");
      const isPart = (m) => !m.content && m.embeds[0]?.title?.endsWith("(continued)");
      const head = recent.findLastIndex(isHead);
      if (head >= 0) {
        old.push(recent[head]);
        for (let k = head + 1; k < recent.length && isPart(recent[k]); k++) old.push(recent[k]);
      }
      for (const m of recent) if ((isHead(m) || isPart(m)) && !old.includes(m)) await remove(m);
    }
    const msgs = [];
    for (let k = 0; k < parts.length; k++) {
      const body = { content: k ? "" : header, embeds: parts[k], allowedMentions: { parse: [] } };
      const m = (old[k] && await old[k].edit(body).catch(() => null)) || await post(channelId, body.content, { embeds: parts[k] });
      if (!m) return null; // tried again later; what was edited stays
      msgs.push(m);
    }
    for (const m of old.slice(parts.length)) await remove(m);
    setMeta("guide_post", JSON.stringify({ channelId, ids: msgs.map((m) => m.id) }));
    return msgs[0];
  }

  // The whole day's programming just after midnight (yesterday's post is edited into today's).
  // If the bot was down at midnight it still posts in the first few hours; later than
  // that it waits for tomorrow rather than post a guide for a half-gone day.
  async function dailyGuide() {
    if (!config.discord.daily_guide || !guideChannel()) return;
    const day = localDay(Date.now());
    if (getMeta("daily_guide_posted") === day.date || Date.now() - day.startMs > 6 * 3600000) return;
    await fillToday();
    if (!dayGuide().lines.length) {
      setMeta("daily_guide_posted", day.date);
      return log.warn("bot: nothing scheduled today; no daily guide post");
    }
    if (!await publishGuide()) return; // tried again next minute
    setMeta("daily_guide_posted", day.date);
    log.info(`bot: posted the guide for ${day.date}`);
  }

  async function followPlayer() {
    for (;;) {
      try {
        const res = await fetch(`${PLAYER_URL}/events`, { headers: { "x-tv-secret": localSecret() } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log.info("bot: connected to player");
        let buf = "";
        const utf8 = new TextDecoder(); // streaming: a character split across chunks stays whole
        for await (const chunk of res.body) {
          buf += utf8.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) await onPlayerEvent(JSON.parse(line.slice(6))).catch((err) => log.warn(`bot: event failed: ${err.message}`));
          }
        }
      } catch (err) {
        log.warn(`bot: player not reachable (${err.message}); retrying in 5s`);
      }
      playerStatus = { state: "off" };
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const inTvChannel = async (i) => {
    const vc = await voiceOf(i);
    return vc && vc === playerStatus.channelId;
  };
  const isAdmin = (userId) => ANYONE_ADMIN || (config.discord.admin_user_id && userId === String(config.discord.admin_user_id));
  const voiceOf = async (interaction) => {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    return member?.voice?.channelId ?? null;
  };

  // The drop threads: anyone posts YouTube (etc.) links or video files; they're added to
  // rotation as commercials or clips, by thread. ⏳ while working, then a reply saying what
  // went in (and why anything was skipped).
  const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|flv|ts)$/i;
  client.on("messageCreate", async (m) => {
    const kind = dropThreads.get(m.channelId);
    if (!kind || m.author.bot) return;
    const urls = [...new Set(m.content.match(/https?:\/\/\S+/g) || [])].map((u) => u.replace(/[)>\]]+$/, ""));
    const files = [...m.attachments.values()].filter((a) => a.contentType?.startsWith("video/") || VIDEO_FILE.test(a.name || ""))
      .map((a) => ({ id: a.id, name: a.name || `${a.id}.mp4`, url: a.url }));
    if (!urls.length && !files.length) return;
    await m.react("⏳").catch(() => {});
    let text, ok;
    try {
      const done = await maintenance.run(async () => [
        ...(files.length ? await addFromFiles(kind, files) : []),
        ...(urls.length ? await addFromUrls(kind, urls) : []),
      ]);
      const added = done.filter((a) => !a.skipped);
      ok = added.length > 0;
      text = done.map((a) => (a.skipped ? `Skipped "${a.title}": ${a.skipped}` : `Added ${kind}: "${a.title}"`)).join("\n") || "No videos found at those links.";
      log.info(`bot: drop thread: ${m.author.username} added ${added.length} of ${done.length} (${kind})`);
    } catch (e) {
      ok = false;
      text = `Couldn't add that: ${e.message.split("\n")[0]}`;
      log.warn(`bot: drop thread failed: ${e.message}`);
    }
    await m.reactions.cache.get("⏳")?.users.remove(client.user.id).catch(() => {});
    await m.react(ok ? "✅" : "⚠️").catch(() => {});
    await m.reply({ content: text.slice(0, 1900), allowedMentions: { parse: [], repliedUser: false } }).catch((e) => log.warn(`bot: drop thread reply failed: ${e.message}`));
  });

  client.on("interactionCreate", async (i) => {
    try {
      if (i.isChatInputCommand() && i.commandName === "entrance") {
        const sub = i.options.getSubcommand();
        if (sub === "set") {
          await i.deferReply(ephemeral);
          try {
            const secs = await setEntrance(i.user.id, i.options.getAttachment("file"));
            return i.editReply(`Entrance sound saved (${secs.toFixed(1)}s). It plays when you join the TV's voice channel while the TV is on.`);
          } catch (e) {
            return i.editReply(e.message);
          }
        }
        const target = i.options.getUser("user") ?? i.user;
        if (target.id !== i.user.id && !isAdmin(i.user.id)) return i.reply({ content: "You can only clear your own entrance sound.", ...ephemeral });
        const had = clearEntrance(target.id);
        return i.reply({ content: had ? "Entrance sound removed." : "No entrance sound to remove.", ...ephemeral });
      }
      // Pause / resume: anyone watching in the TV's voice channel.
      const pauseCmd = (i.isChatInputCommand() && i.commandName === "tvpause") || (i.isButton() && i.customId === "tv:pause");
      const resumeCmd = (i.isChatInputCommand() && i.commandName === "tvresume") || (i.isButton() && i.customId === "tv:resume");
      const liveCmd = i.isChatInputCommand() && i.commandName === "tvlive";
      if (pauseCmd || resumeCmd || liveCmd) {
        if (!(await inTvChannel(i))) return i.reply({ content: "Only people in the TV's voice channel can do that.", ...ephemeral });
        await callPlayer(pauseCmd ? "/pause" : resumeCmd ? "/resume" : "/live", {});
        return i.reply({ content: pauseCmd ? "Paused." : resumeCmd ? "Picking up where it left off." : "Jumping to what's on now.", ...ephemeral });
      }
      if (i.isChatInputCommand() && ["tv", "tvoff", "tvadmin"].includes(i.commandName)) {
        if (i.commandName === "tv") {
          const vc = await voiceOf(i);
          if (!vc) return i.reply({ content: "Join a voice channel first, then use /tv.", ...ephemeral });
          await i.deferReply(ephemeral);
          await callPlayer("/join", { channelId: vc });
          return i.editReply(`TV is on in <#${vc}>.`);
        }
        if (i.commandName === "tvoff") {
          await i.deferReply(ephemeral);
          await callPlayer("/leave", {});
          return i.editReply("TV is off.");
        }
        if (!isAdmin(i.user.id)) return i.reply({ content: "Only the TV admin can do that.", ...ephemeral });
        const sub = i.options.getSubcommand();
        if (sub === "skip") {
          const r = await callPlayer("/skip-item", {});
          return i.reply({ content: r.skipped ? "Skipped." : "Nothing is playing.", ...ephemeral });
        }
        if (sub === "skipblock") {
          const r = await callPlayer("/skip-block", {});
          return i.reply({ content: r.skipped ? "Skipped the rest of this block." : "Nothing to skip.", ...ephemeral });
        }
        if (sub === "sync") {
          await i.deferReply(ephemeral);
          await maintenance.run(() => runSync()); // not alongside upkeep, a drop-thread add, ...
          return i.editReply("Catalog sync finished.");
        }
        if (sub === "add") {
          await i.deferReply(ephemeral);
          const urls = i.options.getString("urls").split(/\s+/).filter((u) => /^https?:\/\//.test(u));
          if (maintenance.pending) await i.editReply("Waiting for another TV job (a catalog sync or schedule update) to finish first; this message updates when your links are in.").catch(() => {});
          else await i.editReply(`Downloading ${urls.length} link${urls.length === 1 ? "" : "s"}...`).catch(() => {});
          const done = await maintenance.run(() => addFromUrls(i.options.getString("kind"), urls));
          return i.editReply(done.map((a) => (a.skipped ? `Skipped "${a.title}": ${a.skipped}` : `Added "${a.title}"`)).join("\n") || "No links found.");
        }
        if (sub === "special") {
          await i.deferReply(ephemeral);
          const done = await maintenance.run(() => planSpecials({ request: i.options.getString("request"), days: 8 }));
          const lines = done.map((s) => `${s.label}: <t:${Math.floor(s.start / 1000)}:F> to <t:${Math.floor(s.end / 1000)}:t>`);
          return i.editReply(`Scheduled:\n${lines.join("\n")}`);
        }
        if (sub === "regen") {
          await i.deferReply(ephemeral);
          const replan = i.options.getBoolean("new_grid") ?? false;
          await maintenance.run(() => generateSchedule({ replace: true, replan, days: config.broadcast.plan_days }));
          return i.editReply("New schedule is ready (from the next block on). /schedule to see it.");
        }
      }
      if (i.isChatInputCommand() && i.commandName === "tvhelp") {
        // Posted for everyone; the previous help post is removed so there's only ever one.
        await i.reply({ embeds: helpEmbeds(), allowedMentions: { parse: [] } });
        const msg = await i.fetchReply();
        const prev = JSON.parse(getMeta("help_post") || "null");
        if (prev && prev.id !== msg.id) {
          const ch = await client.channels.fetch(prev.channelId).catch(() => null);
          await remove(await ch?.messages.fetch(prev.id).catch(() => null));
        }
        setMeta("help_post", JSON.stringify({ channelId: msg.channelId, id: msg.id }));
        return;
      }
      if (i.isChatInputCommand() && i.commandName === "schedule") {
        if (i.options.getBoolean("week")) {
          // Only block kinds: the actual shows are picked about a day ahead.
          const days = weekGrid().slice(0, 10);
          if (!days.length) return i.reply({ content: "No week planned yet.", ...ephemeral });
          const messages = guideMessages(days);
          await i.reply({ content: "This week's lineup (shows are picked a day ahead; times shift a little as the day goes).", embeds: messages[0], ...ephemeral });
          for (const embeds of messages.slice(1)) await i.followUp({ embeds, ...ephemeral });
          return;
        }
        // Refresh the guide post in the TV channel (edited, no new copy), and tell only the
        // person who asked, with a link (a private reply they can dismiss).
        await i.deferReply(ephemeral);
        await fillToday();
        const guide = await publishGuide();
        if (!guide) return i.editReply("Couldn't update the TV guide post right now. Try again in a minute.");
        return i.editReply(`Schedule updated: ${linkTo(guide)}`);
      }
      if (i.isButton() && i.customId.startsWith("tv:skip:")) {
        const breakId = i.customId.slice("tv:skip:".length);
        const vc = await voiceOf(i);
        if (!vc || vc !== playerStatus.channelId) {
          return i.reply({ content: "Only people watching in the TV's voice channel can skip.", ...ephemeral });
        }
        const r = await callPlayer("/skip-break", { breakId });
        if (!r.skipped) return i.reply({ content: "That break is already over.", ...ephemeral });
        breakMsg = null;
        await i.update({ content: `Commercials skipped by ${i.member?.displayName ?? i.user.username}`, components: [] });
        removeLater(i.message, 60000);
        return;
      }
      // Anything else (e.g. Coup's buttons) belongs to the other program: ignore.
    } catch (e) {
      log.warn(`bot: ${i.isChatInputCommand?.() ? `/${i.commandName}` : "button"} failed: ${e.message}`);
      const msg = { content: "The TV isn't responding right now. Try again in a minute.", ...ephemeral };
      if (i.deferred) await i.editReply(msg.content).catch(() => {});
      else if (!i.replied) await i.reply(msg).catch(() => {});
    }
  });

  client.once("clientReady", async () => {
    log.info(`bot: logged in as ${client.user.tag}`);
    if (!config.discord.now_playing_channel_id) log.warn("bot: discord.now_playing_channel_id not set; no now-playing posts");
    if (!config.discord.admin_user_id) log.warn("bot: discord.admin_user_id not set; /tvadmin is locked");
    if (ANYONE_ADMIN) log.warn("bot: discord.admin_user_id is \"*\"; anyone can use /tvadmin");
    await registerCommands().catch((e) => log.error("bot: couldn't register commands:", e.message));
    try { writeFileSync(join(DATA_DIR, "app-id.txt"), client.application.id); } catch { /* presence just shows less */ }
    await cleanUpOldPosts().catch((e) => log.warn(`bot: cleanup failed: ${e.message}`));
    followPlayer();
    // Keep the catalog, tags and schedule topped up. Hourly check; cheap when nothing's due.
    const tick = () => maintenance.run(upkeep).catch((e) => log.error("bot: upkeep failed:", e.message));
    tick();
    setInterval(tick, 3600000).unref();
    let guideBusy = false; // programming the day can take longer than the minute between checks
    const guideTick = async () => {
      if (guideBusy) return;
      guideBusy = true;
      await dailyGuide().catch((e) => log.warn(`bot: daily guide failed: ${e.message}`));
      guideBusy = false;
    };
    guideTick();
    setInterval(guideTick, 60000).unref();
    // Watchdog: if the player stops answering for 2 minutes (frozen, not just
    // restarting), kill it; the service manager starts a fresh one.
    let playerPid = null, misses = 0;
    setInterval(async () => {
      try {
        const st = await callPlayer("/status", undefined, 5000);
        playerPid = st.pid ?? playerPid;
        misses = 0;
      } catch {
        if (++misses < 4 || !playerPid) return;
        log.warn(`bot: player (pid ${playerPid}) hasn't answered for 2 minutes; killing it so it restarts`);
        try { process.kill(playerPid); } catch (e) { log.warn(`bot: couldn't kill the player: ${e.message}`); }
        playerPid = null;
        misses = 0;
      }
    }, 30000).unref();

    // tv.cmd restart drops this file; exit so the service manager starts a fresh copy.
    setInterval(() => {
      if (!existsSync(RESTART_FLAG)) return;
      rmSync(RESTART_FLAG, { force: true });
      log.info("bot: restarting to load new code/settings");
      maintenance.run(() => process.exit(0));
    }, 10000).unref();
  });

  await client.login(secrets.botToken);
  return client;
}
