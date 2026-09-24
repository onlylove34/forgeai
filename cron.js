video bulunamadı hatası 
Yapıştırılan metin(5).txt
Belge
Yapıştırılan metin(6).txt
Belge
Yapıştırılan metin(7).txt
Belge
241b7a1f-41d3-48de-aca6-6d1af08842c9.BACKUP_BEFORE_AI_STRATEGY
Dosya
 hangisi klasöre bak ya ck karısık
Yapıştırılan metin(8).txt
Belge
ben yaamadım sanırım değiştirilmiş halini ver bana
yanlıslıkla kntrl c yatım srun lurmu 
nerede
nerede
sanırım bıttı 
Yapıştırılan metin(9).txt
Belge

Evet, burada önemli bir şey yakaladık. Cron çalışıyor, fakat bizim mevcut test-start sistemi işi RAM'deki Map içinde tutuyor.

Yani Cron:

Cron
 ↓
Web Service'e "başlat" dedi
 ↓
jobId oluşturuldu
 ↓
Cron başarıyla bitti
 ↓
Web Service tarafındaki job kaydı artık bulunamadı

Bu yüzden:

{"ok":false,"error":"Üretim işi bulunamadı."}

gördük.

Bu bir API anahtarı problemi değil. Cron da çalışıyor. Mimariyi biraz sağlamlaştırmamız gerekiyor.

Şimdi hiçbir şeyi değiştirme.

Önce Render Web Service'in şu anki durumunu kontrol edelim:

https://forgeai-e1ct.onrender.com/api/automation/scheduler-status

çıktısını gönder.

Sonuca göre sana Cron'un işi gerçekten tamamlayana kadar takip edeceği sürümü kuracağız. Böylece:

08:00 → konu → video → YouTube yüklemesi tamamlanmadan Cron bitmeyecek.

{"ok":true,"enabled":true,"timezone":"Europe/Istanbul","videosPerDay":5,"schedule":["08:00","11:00","14:00","17:00","20:00"],"currentTime":"2026-09-24 22:00","busy":false,"lastJob":null}

Evet, bu sonuç aslında sorunun tam yerini gösteriyor:

"busy": false,
"lastJob": null

Bu endpoint Web Service'in kendi scheduler'ını gösteriyor. Cron Job ise ayrı bir servis. Yani Cron'un çalışması, Web Service içindeki lastJob alanını doldurmuyor.

Ayrıca Cron'un şu an yaptığı şey:

Cron → /api/automation/test-start → jobId al → Cron biter

test-start ise üretimi RAM'deki Map içinde arka planda tutuyor.

Bunu şimdi sağlamlaştıracağız

En doğru çözüm, Cron'un sadece "başlat" deyip çıkmaması; üretimin sonucunu kalıcı bir şekilde takip etmesi.

Render da uzun süren işleri web isteğinin içine bağlamamayı öneriyor; bunun için ayrı iş/workflow yaklaşımı kullanılıyor.

Ama bizim mevcut sistemi bozmadan ilerlemek için önce küçük bir düzeltme yapacağız.

Şimdilik Cron Job'ı silme, server.jse dokunma.

Bir sonraki adımda sana cron.js için düzeltilmiş sürümü vereceğim. Böylece:

Cron → konu → üretim → MP4 → YouTube → tamamlandı

zincirini gerçekten doğrulayacağız.

{"ok":true,"enabled":true,"timezone":"Europe/Istanbul","videosPerDay":5,"schedule":["08:00","11:00","14:00","17:00","20:00"],"currentTime":"2026-09-24 22:01","busy":false,"lastJob":null}

Evet, bu sonuç aynı ve beklenen sonuç. Burayı tekrar test etmene gerek yok. lastJob: null, Web Service'in kendi scheduler'ını gösteriyor; bizim yeni Cron Job'ı göstermiyor.

Asıl düzeltmeyi yapacağız:

Sorun

Şu anda cron.js:

Cron → /api/automation/test-start → jobId → çıkıyor

test-start işi RAM'de tutuyor.

Yapacağımız

cron.js artık arka plan job başlatmayacak.

Bunun yerine:

Cron → konu oluştur → /api/automation/test-production → MP4 oluştur → YouTube'a yükle → sonuç dön → Cron tamamlan

Mevcut test-production zaten MP4 üretip YouTube'a public yükleme yapıyor.

Bu çok daha doğru.

Şimdi Cron Job'ı silme.

GitHub → cron.js → Edit.

Mevcut kodun tamamını bununla değiştireceğiz:

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

Sonra Commit changes.

Sadece bunu yap. Commit tamamlanınca ekran görüntüsünü gönder; sonraki adımda Cron'u yeniden deploy edip gerçek YouTube yüklemesini test edeceğiz.
