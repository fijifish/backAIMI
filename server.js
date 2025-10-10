import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "./models/User.js";

const app = express();

app.use(cors({
  origin: [
    "https://onex-gifts.vercel.app"                     // ← для локальной разработки
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-telegram-id"],
  optionsSuccessStatus: 204
}));

// ✅ Чтобы preflight-запросы OPTIONS не ломали бэкенд
app.options("*", cors());

// ✅ Парсим JSON в body
app.use(express.json({ limit: "1mb" }));

// ✅ Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ✅ Проверка
app.get("/ping", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.type("text/plain").send("OK"));



// ✅ Регистрируем пользователя (как в Octys)
app.post("/register-user", async (req, res) => {
  try {
    const { telegramId, username, firstName, lastName, photoUrl, ref } = req.body;

    if (!telegramId) {
      return res.status(400).json({ error: "telegramId is required" });
    }

    let user = await User.findOne({ telegramId });

    // Если нового пользователя нет — создаём
    if (!user) {
      const newUser = new User({
        telegramId,
        username: username || null,
        firstName: firstName || null,
        lastName: lastName || null,
        photoUrl: photoUrl || null,
        balance: 0,
        referredBy: ref || null,
      });
      await newUser.save();
      console.log(`✅ Новый пользователь добавлен: ${telegramId}`);
      return res.json({ ok: true, user: newUser });
    }

    // Если пользователь уже есть — обновляем
    user.username = username || user.username;
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.photoUrl = photoUrl || user.photoUrl;
    await user.save();

    console.log(`🔄 Пользователь обновлён: ${telegramId}`);
    res.json({ ok: true, user });
  } catch (err) {
    console.error("❌ Ошибка при регистрации:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Получить пользователя по ID (если нужно фронту)
app.get("/get-user", async (req, res) => {
  try {
    const { telegramId } = req.query;
    if (!telegramId) return res.status(400).json({ error: "telegramId is required" });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET для проверки, что маршрут жив (вернёт 405)
app.get("/tasks/channel/verify", (_req, res) => res.status(405).json({ ok:false, error:"Use POST" }));

// POST: проверяет подписку и один раз начисляет TON
app.post("/tasks/channel/verify", async (req, res) => {
  try {
    const { telegramId } = req.body || {};
    if (!telegramId) return res.status(400).json({ ok:false, error: "telegramId is required" });

    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    if (user.tasks?.channelSubscribed) {
      return res.json({ ok:true, status:"already_claimed", user });
    }

    // Bot API
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChatMember`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: process.env.CHANNEL_ID, user_id: String(telegramId) })
    });
    const data = await resp.json();
    if (!data.ok) return res.status(502).json({ ok:false, error:"Bot API error", details:data });

    const status = data.result?.status;  // 'creator'|'administrator'|'member'|'restricted'|'left'|'kicked'
    const isSub = new Set(["creator","administrator","member","restricted"]).has(status);
    if (!isSub) return res.json({ ok:true, status:"not_subscribed" });

    // Атомарно — чтобы не начислить дважды на гонках
    const upd = await User.updateOne(
      { telegramId: String(telegramId), "tasks.channelSubscribed": { $ne: true } },
      { $inc: { balanceTon: Number(process.env.CHANNEL_REWARD_TON || 0) },
        $set: { "tasks.channelSubscribed": true } }
    );

    if (upd.modifiedCount === 0) {
      return res.json({ ok:true, status:"already_claimed" });
    }

    const fresh = await User.findOne({ telegramId: String(telegramId) });
    return res.json({ ok:true, status:"rewarded", reward:{ ton:Number(process.env.CHANNEL_REWARD_TON||0) }, user:fresh });
  } catch (e) {
    console.error("/tasks/channel/verify error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

// // ✅ miniapp bridge для диагностики доступности фронта
// app.get("/miniapp", (req, res) => {
//   // 👉 сюда добавляй зеркала по мере готовности
//   const MIRRORS = [
//     "https://moonlit-sunshine-36a99e.netlify.app",
//     "https://onex-gifts.vercel.app" // пример — твой прод на Vercel
//     // "https://your-custom-domain.com" // если заведёшь Cloudflare-прокси
//   ];

//   res.setHeader("Content-Type", "text/html; charset=utf-8");
//   res.end(`<!doctype html>
// <html><head><meta charset="utf-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>AIMI Bridge</title>
// <style>
//   body{background:#000;color:#fff;font-family:-apple-system,system-ui,Segoe UI,Roboto,Arial;
//        display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;text-align:center}
//   a{color:#4af}
//   .hint{opacity:.7;font-size:14px;margin-top:8px}
// </style>
// </head>
// <body>
//   <div id="status">Проверяем доступность фронта…</div>
//   <div class="hint">Если ожидание долгое, провайдер может резать трафик.</div>
// <script>
// (async function(){
//   const session = 'sess_'+Math.random().toString(36).slice(2,8);
//   const mirrors = ${JSON.stringify(MIRRORS)};
//   const LOG = "${req.protocol}://${req.get('host')}/client-log";

//   const log = (type, extra={}) =>
//     fetch(LOG, {method:'POST',headers:{'Content-Type':'application/json'},
//       body: JSON.stringify(Object.assign({type, session, ts:Date.now()}, extra)),
//       keepalive:true}).catch(()=>{});

//   log('bridge-open', {mirrors});

//   // маленький помощник с таймаутом
//   const probe = (url, timeoutMs=12000) => new Promise((resolve, reject)=>{
//     const ctrl = new AbortController();
//     const t = setTimeout(()=>ctrl.abort(), timeoutMs);
//     fetch(url, {mode:'no-cors', signal:ctrl.signal})
//       .then(()=>{ clearTimeout(t); resolve(url); })
//       .catch(err=>{ clearTimeout(t); reject({url, err:String(err)}); });
//   });

//   // пробуем зеркала по очереди (можно поменять на Promise.any)
//   for (const url of mirrors) {
//     document.getElementById('status').innerText = 'Пробуем: ' + url;
//     try {
//       await probe(url, 12000);
//       log('front-ok', {url});
//       location.replace(url);
//       return;
//     } catch(e){
//       log('front-fail', e);
//     }
//   }

//   // если сюда дошли — ни одно зеркало не ответило вовремя
//   document.getElementById('status').innerHTML =
//     '❌ Фронт сейчас недоступен из вашей сети.<br><br>' +
//     mirrors.map(u => '<div><a href="'+u+'">'+u+'</a></div>').join('') +
//     '<div class="hint">Попробуйте другое зеркало или VPN.</div>';
// })();
// </script>
// </body></html>`);
// });

// app.post("/client-log", express.json({ limit: "100kb" }), (req, res) => {
//   console.log("[client-log]", req.body);
//   res.json({ ok: true });
// });

// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});