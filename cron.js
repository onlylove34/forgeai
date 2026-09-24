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
- suitable for AI-generated visuals
- suitable for YouTube

Return ONLY JSON:
{"title":"..."}
`
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI topic error: ${text}`);
  }

  const data = await response.json();

  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI topic cevabı boş.");
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("OpenAI JSON cevabı okunamadı.");
    }

    parsed = JSON.parse(match[0]);
  }

  if (!parsed.title) {
    throw new Error("Konu başlığı oluşturulamadı.");
  }

  return parsed.title;
}

async function startProduction(topic) {
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

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Video üretimi başlatılamadı: ${text}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Backend geçersiz cevap verdi: ${text}`
    );
  }

  if (!data.ok) {
    throw new Error(
      data.error || "Backend üretimi başlatamadı."
    );
  }

  return data;
}

async function main() {
  console.log("=================================");
  console.log("AI YouTube Factory Cron");
  console.log("=================================");

  console.log("Yeni otomatik konu oluşturuluyor...");

  const topic = await createTopic();

  console.log("Yeni otomatik konu:", topic);

  console.log("Video üretimi Background Worker'a gönderiliyor...");

  const result = await startProduction(topic);

  console.log("Üretim kuyruğa başarıyla bırakıldı.");
  console.log("Job ID:", result.jobId);
  console.log("Status:", result.status);

  console.log("Cron kapanıyor.");
  console.log("Video üretimini forgeai-worker sürdürecek.");

  process.exit(0);
}

main().catch((error) => {
  console.error("CRON ERROR:", error);
  process.exit(1);
});
