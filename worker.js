import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { google } from "googleapis";
import ffmpegPath from "ffmpeg-static";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";
if (!REDIS_URL) throw new Error("REDIS_URL eksik. Render Key Value bağlantısı gerekli.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY eksik.");
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
  throw new Error("Google OAuth env değişkenleri eksik.");
}
if (!process.env.YOUTUBE_TOKEN_JSON) {
  throw new Error("YOUTUBE_TOKEN_JSON eksik. YouTube OAuth token'ını Worker'a ekleyin.");
}

const redis = new Redis(REDIS_URL);
const queueRedis = redis.duplicate();
const JOB_QUEUE = "aiyt:video:queue";
const DATA_DIR = path.resolve("data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const VIDEO_DIR = path.join(DATA_DIR, "video");
const token = JSON.parse(process.env.YOUTUBE_TOKEN_JSON);

await fs.mkdir(AUDIO_DIR, { recursive: true });
await fs.mkdir(VIDEO_DIR, { recursive: true });

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const enhancedArgs = args.map(arg => {
      if (arg.includes("scale=")) {
        return arg.replace(
          "scale=",
          "zoompan=z='if(lte(zoom,1.0),1.5,zoom-0.001)':d=125,scale="
        );
      }
      return arg;
    });

    const child = spawn(ffmpegPath, enhancedArgs);
    let stderr = "";
    child.stderr.on("data", c => stderr += c.toString());
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-8000) || `FFmpeg exit code: ${code}`));
    });
  });
}

function youtubeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function updateJob(jobId, patch) {
  const key = `aiyt:job:${jobId}`;
  const raw = await redis.get(key);
  const current = raw ? JSON.parse(raw) : { jobId };
  const next = { ...current, ...patch };
  await redis.set(key, JSON.stringify(next), "EX", 604800);
  return next;
}

async function createProduction(job) {
  const topic = String(job.topic || "Amazing facts about space");
  const language = String(job.language || "English");
  const duration = Number(job.durationMinutes || 1);
  const quality = String(job.quality || "720p");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  await updateJob(job.jobId, { status: "script", progress: 10 });

  const scriptPrompt = `
Create a short YouTube video script in ${language} about:
"${topic}"

Duration: approximately ${duration} minute.

Return ONLY valid JSON:
{
  "scenes": [
    {
      "narration": "spoken narration",
      "visual": "detailed image generation prompt"
    }
  ]
}

Create 3 to 5 scenes.
`;

  const scriptResult = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: scriptPrompt }]
  });

  const rawScript = String(scriptResult.choices[0].message.content || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const scriptData = JSON.parse(rawScript);

  if (!Array.isArray(scriptData.scenes) || !scriptData.scenes.length) {
    throw new Error("AI sahne listesi oluşturamadı.");
  }

  const scenes = [];
  const total = scriptData.scenes.length;

  for (let i = 0; i < total; i++) {
    const scene = scriptData.scenes[i];
    const progress = 15 + Math.round((i / total) * 35);
    await updateJob(job.jobId, { status: "assets", progress, scene: i + 1, totalScenes: total });

    const speech = await client.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: String(scene.narration)
    });

    const audioFilename = `auto_voice_${Date.now()}_${i}.mp3`;
    const audioPath = path.join(AUDIO_DIR, audioFilename);
    await fs.writeFile(audioPath, Buffer.from(await speech.arrayBuffer()));

    const image = await client.images.generate({
      model: "gpt-image-2",
      prompt: `${scene.visual}. High-quality cinematic YouTube style, 16:9 composition.`,
      size: "1536x1024",
      output_format: "png"
    });

    const imageFilename = `auto_image_${Date.now()}_${i}.png`;
    const imagePath = path.join(AUDIO_DIR, imageFilename);
    await fs.writeFile(imagePath, Buffer.from(image.data[0].b64_json, "base64"));

    scenes.push({ imagePath, audioPath });
  }

  await updateJob(job.jobId, { status: "rendering", progress: 55 });

  const tempFiles = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const out = path.join(VIDEO_DIR, `auto_temp_${Date.now()}_${i}.mp4`);
      tempFiles.push(out);

      let scale = "1280:720";
      if (quality === "1080p") scale = "1920:1080";
      else if (quality === "4K") scale = "3840:2160";

      await runFfmpeg([
        "-y", "-loop", "1", "-i", scene.imagePath, "-i", scene.audioPath,
        "-vf", `scale=${scale},format=yuv420p`,
        "-c:v", "libx264", "-c:a", "aac", "-shortest", out
      ]);

      await updateJob(job.jobId, {
        status: "rendering",
        progress: 55 + Math.round(((i + 1) / scenes.length) * 25)
      });
    }

    const listFile = path.join(VIDEO_DIR, `auto_list_${Date.now()}.txt`);
    const finalFile = `auto_test_${Date.now()}.mp4`;
    const finalPath = path.join(VIDEO_DIR, finalFile);

    await fs.writeFile(listFile, tempFiles.map(f => `file '${f}'`).join("\n"));
    await runFfmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", finalPath
    ]);

    await fs.unlink(listFile).catch(() => {});
    for (const f of tempFiles) await fs.unlink(f).catch(() => {});

    await updateJob(job.jobId, { status: "uploading", progress: 90, videoFile: finalFile });

    const oauth = youtubeClient();
    oauth.setCredentials(token);
    const youtube = google.youtube({ version: "v3", auth: oauth });

    const title = topic.slice(0, 100);
    const description = `AI YouTube Factory tarafından otomatik olarak oluşturuldu.\n\nTopic: ${topic}`;

    const uploadResult = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "22" },
        status: { privacyStatus: "public" }
      },
      media: {
        body: (await import("node:fs")).createReadStream(finalPath)
      }
    });

    const videoId = uploadResult.data.id || "";

    return {
      status: "completed",
      progress: 100,
      topic,
      scenes: scenes.length,
      videoPath: `/api/video/${finalFile}`,
      videoId,
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
      finishedAt: new Date().toISOString(),
      message: "Otomatik üretim ve YouTube yüklemesi tamamlandı."
    };
  } finally {
    for (const scene of scenes) {
      await fs.unlink(scene.audioPath).catch(() => {});
      await fs.unlink(scene.imagePath).catch(() => {});
    }
    for (const f of tempFiles) await fs.unlink(f).catch(() => {});
  }
}

async function processJob(job) {
  await updateJob(job.jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    worker: process.env.RENDER_SERVICE_NAME || "aiyt-worker"
  });

  try {
    const result = await createProduction(job);
    await updateJob(job.jobId, result);
    console.log(`[WORKER] COMPLETED ${job.jobId} ${result.url || ""}`);
  } catch (error) {
    await updateJob(job.jobId, {
      status: "failed",
      progress: 100,
      error: error?.message || String(error),
      finishedAt: new Date().toISOString()
    });
    console.error(`[WORKER] FAILED ${job.jobId}:`, error);
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[WORKER] Graceful shutdown...");
  await queueRedis.quit().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[WORKER] AI YouTube Factory worker started.");
console.log("[WORKER] Queue:", JOB_QUEUE);

while (!shuttingDown) {
  try {
    const item = await queueRedis.brpop(JOB_QUEUE, 10);
    if (!item) continue;

    const raw = item[1];
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      console.error("[WORKER] Geçersiz queue mesajı:", raw);
      continue;
    }

    console.log(`[WORKER] JOB ${job.jobId} -> ${job.topic}`);
    await processJob(job);
  } catch (error) {
    if (!shuttingDown) {
      console.error("[WORKER] Queue error:", error?.message || error);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
