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

// ✅ Создание заявки на вывод
app.post("/withdraw/create", async (req, res) => {
  try {
    const { telegramId, amount, address } = req.body || {};
    if (!telegramId) return res.status(400).json({ ok:false, error: "telegramId is required" });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ ok:false, error: "Invalid amount" });
    }

    // лёгкая валидация TRC20 (адреса Tron в Base58, начинаются с T, длина 34)
    const addr = String(address || "").trim();
    const isTron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr);
    if (!isTron) {
      return res.status(400).json({ ok:false, error: "Invalid TRC20 address" });
    }

    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    const order = {
      _id: new mongoose.Types.ObjectId(),
      amount: amt,                 // сумма в USDT (как ты и хочешь)
      currency: "USDT",
      address: addr,
      status: "в обработке",       // начальный статус
      createdAt: new Date()
    };

    await User.updateOne(
      { telegramId: String(telegramId) },
      { $push: { withdrawOrders: { $each: [order], $position: 0 } } } // добавим в начало массива
    );

    return res.json({ ok: true, order });
  } catch (e) {
    console.error("POST /withdraw/create error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

// ✅ Список заявок пользователя
app.get("/withdraw/list", async (req, res) => {
  try {
    const { telegramId } = req.query || {};
    if (!telegramId) return res.status(400).json({ ok:false, error: "telegramId is required" });

    const user = await User.findOne({ telegramId: String(telegramId) }).lean();
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    const orders = Array.isArray(user.withdrawOrders) ? user.withdrawOrders : [];
    res.json({ ok:true, orders });
  } catch (e) {
    console.error("GET /withdraw/list error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});