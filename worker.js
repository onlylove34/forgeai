import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { google } from "googleapis";
import ffmpegPath from "ffmpeg-static";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";

if (!REDIS_URL) throw new Error("REDIS_URL eksik.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY eksik.");

const redis = new Redis(REDIS_URL);
const queueRedis = redis.duplicate();
const JOB_QUEUE = "aiyt:video:queue";

const DATA_DIR = path.resolve("data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const VIDEO_DIR = path.join(DATA_DIR, "video");

await fs.mkdir(AUDIO_DIR, { recursive: true });
await fs.mkdir(VIDEO_DIR, { recursive: true });

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const enhancedArgs = args.map((arg) =>
      arg.includes("scale=") ? arg.replace("scale=", "zoompan=z='min(zoom+0.001,1.5)':d=7500,scale=") : arg
    );
    enhancedArgs.unshift("-loglevel", "error"); // Sadece gerçek hataları bas

    const child = spawn(ffmpegPath, enhancedArgs);
    let stderr = "";
    child.stderr.on("data", (c) => stderr += c.toString());
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg Hatası: ${stderr || code}`));
    });
  });
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  await updateJob(job.jobId, { status: "script", progress: 10 });

  // 1. Senaryo Üretimi
  const scriptPrompt = `Create a short YouTube video script in English about: "${job.topic || "Dark psychology"}". Return ONLY JSON format with max 5 scenes: { "scenes": [ { "narration": "text", "visual": "image prompt" } ] }`;
  const scriptResult = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: scriptPrompt }]
  });

  const rawScript = String(scriptResult.choices[0].message.content || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const scriptData = JSON.parse(rawScript);
  if (!scriptData.scenes || !scriptData.scenes.length) throw new Error("Senaryo oluşturulamadı.");

  const scenes = [];

  // 2. Varlıkların Üretimi (Ses ve Görsel)
  for (let i = 0; i < scriptData.scenes.length; i++) {
    const scene = scriptData.scenes[i];
    await updateJob(job.jobId, { status: "assets", progress: 20 + (i * 10), scene: i + 1 });

    // Ses
    const speech = await client.audio.speech.create({ model: "tts-1", voice: "onyx", input: scene.narration });
    const audioPath = path.join(AUDIO_DIR, `audio_${Date.now()}_${i}.mp3`);
    await fs.writeFile(audioPath, Buffer.from(await speech.arrayBuffer()));

    // Görsel (Eğer hata verirse işlem DOĞRU BİR ŞEKİLDE iptal edilecek)
    const image = await client.images.generate({
      model: "dall-e-3",
      prompt: `Cinematic, dark psychology theme: ${scene.visual}. No text, no sensitive content.`,
      size: "1024x1024"
    });

    if (!image.data[0].url) throw new Error("OpenAI görsel URL'si döndürmedi.");

    const imageRes = await fetch(image.data[0].url);
    if (!imageRes.ok || !imageRes.headers.get("content-type")?.includes("image")) {
      throw new Error("OpenAI'den bozuk görsel dosyası geldi.");
    }

    const imagePath = path.join(AUDIO_DIR, `img_${Date.now()}_${i}.png`);
    await fs.writeFile(imagePath, Buffer.from(await imageRes.arrayBuffer()));

    scenes.push({ imagePath, audioPath });
  }

  // 3. Montaj
  await updateJob(job.jobId, { status: "rendering", progress: 70 });
  const tempFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const out = path.join(VIDEO_DIR, `temp_${Date.now()}_${i}.mp4`);
    tempFiles.push(out);
    await runFfmpeg(["-y", "-loop", "1", "-i", scenes[i].imagePath, "-i", scenes[i].audioPath, "-vf", "scale=1280:720,format=yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", out]);
  }

  const listFile = path.join(VIDEO_DIR, `list_${Date.now()}.txt`);
  const finalFile = `final_${Date.now()}.mp4`;
  const finalPath = path.join(VIDEO_DIR, finalFile);

  await fs.writeFile(listFile, tempFiles.map((f) => `file '${f}'`).join("\n"));
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath]);

  // Temizlik
  await fs.unlink(listFile).catch(() => {});
  for (const f of tempFiles) await fs.unlink(f).catch(() => {});
  for (const s of scenes) {
    await fs.unlink(s.audioPath).catch(() => {});
    await fs.unlink(s.imagePath).catch(() => {});
  }

  return { status: "awaiting_approval", progress: 100, videoPath: `/api/video/${finalFile}` };
}

async function processJob(job) {
  await updateJob(job.jobId, { status: "running" });
  try {
    const result = await createProduction(job);
    await updateJob(job.jobId, result);
    console.log(`[WORKER] BAŞARILI: ${job.jobId}`);
  } catch (error) {
    // Hata durumunda sistemi çökertmek yerine işlemi iptal edip kullanıcıya bilgi veriyoruz.
    await updateJob(job.jobId, { status: "failed", error: error.message });
    console.error(`[WORKER] İPTAL EDİLDİ: ${job.jobId} - Hata:`, error.message);
  }
}

// ... (Redis döngüsü aynı kalıyor)
let shuttingDown = false;
process.on("SIGTERM", () => shuttingDown = true);
process.on("SIGINT", () => shuttingDown = true);

console.log("[WORKER] Sistem başlatıldı. Görev bekleniyor...");
while (!shuttingDown) {
  try {
    const item = await queueRedis.brpop(JOB_QUEUE, 10);
    if (!item) continue;
    let job = JSON.parse(item[1]);
    await processJob(job);
  } catch (error) {
    if (!shuttingDown) await new Promise(r => setTimeout(r, 3000));
  }
}