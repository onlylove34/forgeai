const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL;

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY eksik.");
}

if (!BACKEND_URL) {
  throw new Error("BACKEND_URL eksik.");
}

async function createTopic() {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `
Choose ONE original English YouTube topic for a global audience.

Requirements:
- interesting
- safe
- suitable for a 1-minute AI-generated video
- original
- no copyrighted characters

Return ONLY JSON:
{"title":"..."}
`
          }
        ]
      })
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI error: ${text}`);
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `OpenAI JSON hatası: ${text.slice(0, 500)}`
    );
  }

  const raw = String(
    data.choices?.[0]?.message?.content || ""
  )
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  let result;

  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(
      `Konu JSON hatası: ${raw.slice(0, 500)}`
    );
  }

  if (!result.title) {
    throw new Error("Konu oluşturulamadı.");
  }

  return String(result.title).slice(0, 100);
}

async function main() {
  const topic = await createTopic();

  console.log("================================");
  console.log("YENİ OTOMATİK KONU:");
  console.log(topic);
  console.log("================================");

  const response = await fetch(
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

  const responseText = await response.text();

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Backend JSON hatası. HTTP ${response.status}: ${responseText.slice(0, 500)}`
    );
  }

  if (!response.ok || !result.ok || !result.jobId) {
    throw new Error(
      `Üretim başlatılamadı: ${JSON.stringify(result)}`
    );
  }

  console.log("================================");
  console.log("VIDEO ÜRETİMİ BAŞLATILDI");
  console.log("Job ID:", result.jobId);
  console.log("Web Service üretimi arka planda sürdürecek.");
  console.log("Cron bağlantısı kapatılıyor.");
  console.log("================================");
}

main().catch(error => {
  console.error("CRON ERROR:", error);
  process.exit(1);
});
