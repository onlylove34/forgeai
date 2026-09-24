const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL;

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY eksik.");
}

if (!BACKEND_URL) {
  throw new Error("BACKEND_URL eksik.");
}

async function createTopic() {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `
Choose ONE original English YouTube topic for a global audience.

Make it:
- interesting
- safe
- suitable for a 1-minute AI video
- original
- not based on copyrighted characters

Return ONLY JSON:
{"title":"..."}
`
      }]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI error: ${await response.text()}`);
  }

  const data = await response.json();

  const raw = String(data.choices?.[0]?.message?.content || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const result = JSON.parse(raw);

  if (!result.title) {
    throw new Error("Konu oluşturulamadı.");
  }

  return String(result.title).slice(0, 100);
}

async function readJson(response) {
  const text = await response.text();

  if (!text.trim()) {
    throw new Error(`Backend boş cevap verdi. HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Backend JSON yerine farklı cevap verdi. HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }
}

async function main() {
  const topic = await createTopic();

  console.log("Yeni otomatik konu:", topic);
  console.log("Video üretimi başlatılıyor...");

  // 1) Uzun üretim işini arka planda başlat
  const startResponse = await fetch(
    `${BACKEND_URL}/api/automation/test-start`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        topic,
        language: "English",
        durationMinutes: 1,
        quality: "720p"
      })
    }
  );

  const startResult = await readJson(startResponse);

  if (!startResponse.ok || !startResult.ok || !startResult.jobId) {
    throw new Error(
      `Üretim başlatılamadı: ${JSON.stringify(startResult)}`
    );
  }

  const jobId = startResult.jobId;

  console.log("Job başladı:", jobId);

  // 2) İş tamamlanana kadar takip et
  const maxChecks = 90;

  for (let i = 1; i <= maxChecks; i++) {
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log(`Üretim kontrolü ${i}/${maxChecks}...`);

    const statusResponse = await fetch(
      `${BACKEND_URL}/api/automation/test-status/${jobId}`
    );

    const statusResult = await readJson(statusResponse);

    if (statusResult.status === "completed") {
      console.log("================================");
      console.log("VIDEO TAMAMLANDI");
      console.log("Topic:", topic);
      console.log("Video ID:", statusResult.result?.videoId || "");
      console.log("YouTube URL:", statusResult.result?.url || "");
      console.log("================================");

      return;
    }

    if (statusResult.status === "failed") {
      throw new Error(
        `Video üretimi başarısız: ${
          statusResult.error ||
          JSON.stringify(statusResult)
        }`
      );
    }

    console.log("Üretim devam ediyor...");
  }

  throw new Error("Video üretimi 45 dakika içinde tamamlanmadı.");
}

main().catch(error => {
  console.error("CRON ERROR:", error);
  process.exit(1);
});
