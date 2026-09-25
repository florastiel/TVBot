// Proof of concept: throwaway account joins a voice channel and Go Live streams one
// source (local file path or http URL), then leaves.
//   tv.cmd poc\stream.js <file-or-url> [seekSeconds]
import "dotenv/config";
import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from "@dank074/discord-video-stream";
import { makeEncoder } from "../src/encoders.js";

const [source, seekArg] = process.argv.slice(2);
if (!source) {
  console.error("usage: tv.cmd poc\stream.js <file-or-url> [seekSeconds]");
  process.exit(1);
}
const { STREAMER_TOKEN, GUILD_ID, VOICE_CHANNEL_ID } = process.env;
for (const [k, v] of Object.entries({ STREAMER_TOKEN, GUILD_ID, VOICE_CHANNEL_ID })) {
  if (!v) { console.error(`missing ${k} in .env`); process.exit(1); }
}

const streamer = new Streamer(new Client());
await streamer.client.login(STREAMER_TOKEN);
console.log(`logged in as ${streamer.client.user.tag}`);

await streamer.joinVoice(GUILD_ID, VOICE_CHANNEL_ID);
console.log("joined voice");

const seek = Number(seekArg) || 0;
const { command, output } = prepareStream(source, {
  encoder: makeEncoder(process.env.ENCODER || "software"),
  height: 720,
  frameRate: 30,
  bitrateVideo: 2500,
  bitrateVideoMax: 4000,
  videoCodec: Utils.normalizeVideoCodec("H264"),
  includeAudio: true,
  customInputOptions: seek ? ["-ss", String(seek)] : [],
});
command.on("error", (err) => console.error("ffmpeg error:", err.message));

// Ctrl+C stops cleanly instead of leaving a ghost in the voice channel.
const quit = () => { streamer.stopStream(); streamer.leaveVoice(); streamer.client.destroy(); process.exit(0); };
process.on("SIGINT", quit);

console.log(`streaming ${source.replace(/X-Plex-Token=[^&]+/, "X-Plex-Token=***")}${seek ? ` from ${seek}s` : ""}`);
const started = Date.now();
try {
  await playStream(output, streamer, { type: "go-live" });
  console.log(`finished after ${Math.round((Date.now() - started) / 1000)}s`);
} catch (e) {
  console.error("stream failed:", e);
}
quit();
