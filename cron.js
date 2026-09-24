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
    throw new Error(await response.text());
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

async function main() {
  const topic = await createTopic();

  console.log("Yeni otomatik konu:", topic);
  console.log("Video üretimi başlıyor...");

  const response = await fetch(
    `${BACKEND_URL}/api/automation/test-production`,
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

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(JSON.stringify(result));
  }

  console.log("VIDEO TAMAMLANDI:", result);
  console.log("YouTube URL:", result.url || "URL yok");
}

main().catch(error => {
  console.error("CRON ERROR:", error);
  process.exit(1);
});
