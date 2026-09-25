// The remote control: a normal Discord bot. Never touches voice; tells the player what
// to do over local HTTP. Every message it posts is a fixed template filled with real
// metadata (no AI-written text).
//
// It shares its login with coupbot. Coup uses only "!coup" text commands, so there's no
// clash, but to stay safe: commands are added one at a time (never a bulk overwrite
// that would wipe someone else's), and interactions that aren't ours are ignored.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, MessageFlags, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { config, secrets } from "../config.js";
import { log } from "../log.js";
import { PLAYER_URL, callPlayer, localSecret } from "../local.js";
import { runSync } from "../catalog/index.js";
import { setEntrance, clearEntrance } from "./entrance.js";

const guildId = () => config.discord.guild_id || process.env.GUILD_ID;
const ephemeral = { flags: MessageFlags.Ephemeral };

const COMMANDS = [
  new SlashCommandBuilder().setName("tv").setDescription("Turn on the TV in the voice channel you're in"),
  new SlashCommandBuilder().setName("tvoff").setDescription("Turn off the TV"),
  new SlashCommandBuilder().setName("tvadmin").setDescription("TV admin controls")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("skip").setDescription("Skip whatever is playing (e.g. a broken file)"))
    .addSubcommand((s) => s.setName("sync").setDescription("Re-read the Plex and local catalog now")),
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

  async function clearBreakMsg(text) {
    const m = breakMsg;
    breakMsg = null;
    if (!m) return;
    await (text ? m.edit({ content: text, components: [] }) : m.delete()).catch(() => {});
  }

  async function onPlayerEvent(e) {
    playerStatus = e.status;
    if (e.type === "break-start") {
      // In the voice channel's own chat, where the viewers are.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tv:skip:${e.breakId}`).setLabel("Skip commercials").setStyle(ButtonStyle.Secondary));
      breakMsg = await post(e.status.channelId, "Commercial break", { components: [row] });
    } else if (e.type === "break-end" || e.type === "off") {
      await clearBreakMsg();
    } else if (e.type === "show") {
      const lines = [`Now playing: ${label(e.show)}`];
      if (e.upNext) lines.push(`Up next: ${label(e.upNext)}`);
      await post(config.discord.now_playing_channel_id, lines.join("\n"));
    }
  }

  // Follow the player's event stream; reconnect whenever it restarts.
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
        if (sub === "sync") {
          await i.deferReply(ephemeral);
          await runSync();
          return i.editReply("Catalog sync finished.");
        }
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
        return i.update({ content: `Commercials skipped by ${i.member?.displayName ?? i.user.username}`, components: [] });
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
    followPlayer();
  });

  await client.login(secrets.botToken);
  return client;
}
