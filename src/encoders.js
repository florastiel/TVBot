import { Encoders } from "@dank074/discord-video-stream";

// Intel Quick Sync. Not in the library, so defined here in the same shape as its
// built-in nvenc/vaapi encoders. Only works once the Intel iGPU driver is installed.
function qsv({ preset = "veryfast" } = {}) {
  const options = [`-preset ${preset}`, "-look_ahead 0", "-bf 0"];
  return () => ({
    H264: { name: "h264_qsv", options },
    H265: { name: "hevc_qsv", options },
  });
}

// name: "software" (CPU, libx264) or "qsv" (Intel Quick Sync)
export function makeEncoder(name = "software") {
  if (name === "qsv") return qsv();
  return Encoders.software({ x264: { preset: "veryfast" }, x265: { preset: "veryfast" } });
}
