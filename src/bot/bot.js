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
import { addFromUrls } from "../catalog/download.js";
import { localDay, localTime } from "../schedule/time.js";
import { scheduledUntil } from "../schedule/store.js";
import { guideText, weekGrid, dayGuide } from "../schedule/guide.js";
import { runTagging } from "../tagging/tagger.js";
import { tagOrder } from "../tagging/order.js";
import { tagEpisodeThemes } from "../tagging/episodes.js";
import { getMeta, setMeta, getDb } from "../db.js";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

export const RESTART_FLAG = join(DATA_DIR, "restart-bot");

// One background job at a time (sync, tagging, scheduling all write the catalog).
const maintenance = {
  busy: Promise.resolve(),
  run(fn) {
    const job = this.busy.then(fn);
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
    await runSync();
    await runTagging().catch((e) => log.warn(`bot: tagging failed: ${e.message}`));
    await tagOrder().catch((e) => log.warn(`bot: order tagging failed: ${e.message}`));
    await tagEpisodeThemes().catch((e) => log.warn(`bot: episode theme tagging failed: ${e.message}`));
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

const COMMANDS = [
  new SlashCommandBuilder().setName("tv").setDescription("Turn on the TV in the voice channel you're in"),
  new SlashCommandBuilder().setName("tvoff").setDescription("Turn off the TV"),
  new SlashCommandBuilder().setName("tvpause").setDescription("Emergency pause: stop the picture and sound right now"),
  new SlashCommandBuilder().setName("tvresume").setDescription("Pick up where it was paused"),
  new SlashCommandBuilder().setName("tvlive").setDescription("Jump back to what the schedule says is on right now"),
  new SlashCommandBuilder().setName("tvadmin").setDescription("TV admin controls")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
  new SlashCommandBuilder().setName("schedule").setDescription("What's on the TV today")
    .addBooleanOption((o) => o.setName("week").setDescription("The whole week's lineup of block types instead")),
  new SlashCommandBuilder().setName("entrance").setDescription("Your sound when you join the TV's voice channel")
    .addSubcommand((s) => s.setName("set").setDescription(`Upload a sound (only the first ${config.entrance.max_seconds} seconds play)`)
      .addAttachmentOption((o) => o.setName("file").setDescription("mp3, wav, ogg, or a video clip").setRequired(true)))
    .addSubcommand((s) => s.setName("clear").setDescription("Remove an entrance sound")
      .addUserOption((o) => o.setName("user").setDescription("Whose (admin only; default: yours)"))),
];

const label = (seg) => (seg ? `${seg.title}${seg.subtitle ? ` ${seg.subtitle}` : ""}` : "");

export async function startBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
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
    }
  }

  // Follow the player's event stream; reconnect whenever it restarts.
  // The whole day's programming, posted just after midnight. Upkeep only keeps about
  // 12 hours filled, so the rest of the day is programmed first. If the bot was down
  // at midnight it still posts in the first few hours; later than that it waits for
  // tomorrow rather than post a guide for a half-gone day.
  async function dailyGuide() {
    const channelId = config.discord.guide_channel_id || config.discord.now_playing_channel_id;
    if (!config.discord.daily_guide || !channelId) return;
    const day = localDay(Date.now());
    if (getMeta("daily_guide_posted") === day.date || Date.now() - day.startMs > 6 * 3600000) return;
    // Filling can fail (Claude down while planning the grid): then post what there is
    // rather than retry every minute.
    await maintenance.run(async () => {
      const until = scheduledUntil();
      if (until < day.endMs) await generateSchedule({ fromMs: until, days: (day.endMs - until) / 86400000 });
    }).catch((e) => log.warn(`bot: couldn't program the rest of today for the guide: ${e.message}`));
    const guide = dayGuide();
    if (!guide.lines.length) {
      setMeta("daily_guide_posted", day.date);
      return log.warn("bot: nothing scheduled today; no daily guide post");
    }
    const [first, ...rest] = guideMessages([guide]);
    const sent = await post(channelId, "Today on TV (times shift a little as the day goes; /schedule for what's on now)", { embeds: first });
    if (!sent) return; // tried again next minute
    setMeta("daily_guide_posted", day.date);
    for (const embeds of rest) await post(channelId, "", { embeds });
    log.info(`bot: posted the guide for ${day.date}`);
  }

  async function followPlayer() {
    for (;;) {
      try {
        const res = await fetch(`${PLAYER_URL}/events`, { headers: { "x-tv-secret": localSecret() } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log.info("bot: connected to player");
        let buf = "";
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString();
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
  const isAdmin = (userId) => config.discord.admin_user_id && userId === String(config.discord.admin_user_id);
  const voiceOf = async (interaction) => {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    return member?.voice?.channelId ?? null;
  };

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
          await runSync();
          return i.editReply("Catalog sync finished.");
        }
        if (sub === "add") {
          await i.deferReply(ephemeral);
          const urls = i.options.getString("urls").split(/\s+/).filter((u) => /^https?:\/\//.test(u));
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
        return i.reply({ content: guideText(), ...ephemeral, allowedMentions: { parse: [] } });
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
