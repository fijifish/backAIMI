import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "./models/User.js";

const app = express();

const FIRST_DEPOSIT_REWARD_USDT = Number(process.env.FIRST_DEPOSIT_REWARD_USDT || 1);

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

// ===== Partner redirectors (open our domain inside TG, then 302 to partner)
const JETTON_REF = process.env.JETTON_REF || "https://jetton.direct/cgc494NciBw?click_id={click_id}";
const MOSTBET_REF = process.env.MOSTBET_REF || "https://vs66cd75semb.com/zAuF?sub1={telegramId}";

app.get("/go/jetton", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).type("text/plain").send("userId required");

    // свой click_id, чтобы Jetton вернул его как click_slug
    const clickId = `tg_${userId}_${Date.now()}`;
    const url = JETTON_REF.replace("{click_id}", encodeURIComponent(clickId));

    // помечаем клик, чтобы потом сопоставить постбэк
    await User.updateOne(
      { telegramId: String(userId) },
      {
        $addToSet: { "traffic.clickIds": clickId },
        $set: { "traffic.lastOutbound": { provider: "jetton", clickId, at: new Date() } }
      }
    ).catch(() => {});

    return res.redirect(302, url);
  } catch (e) {
    console.error("GET /go/jetton error:", e);
    res.status(500).type("text/plain").send("redirect error");
  }
});

app.get("/go/mostbet", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).type("text/plain").send("userId required");

    const url = MOSTBET_REF.replace("{telegramId}", encodeURIComponent(String(userId)));

    await User.updateOne(
      { telegramId: String(userId) },
      { $set: { "traffic.lastOutbound": { provider: "mostbet", at: new Date() } } }
    ).catch(() => {});

    return res.redirect(302, url);
  } catch (e) {
    console.error("GET /go/mostbet error:", e);
    res.status(500).type("text/plain").send("redirect error");
  }
});

app.get("/postback/jetton", async (req, res) => {

  console.log("[POSTBACK] raw:", req.originalUrl);
  console.log("[POSTBACK] query:", req.query);
  try {
    const {
      player_id,             // их внутренний id игрока (может не совпадать с нашим)
      player_telegram_id,    // Telegram ID (строка, бывает "0", если нет)
      promo_slug,
      click_slug,
      action,                // register | first_deposit | deposit | withdraw
      amount_usd,            // число в USD
      tx_id                  // уникальный id транзакции (используем для идемпотентности)
    } = req.query;

    // 1) Сначала пытаемся найти по Telegram ID
    const telegramId = (player_telegram_id && player_telegram_id !== "0")
      ? String(player_telegram_id)
      : null;

    let user = telegramId
      ? await User.findOne({ telegramId })
      : null;

    // 2) Fallback: если Telegram ID нет, сопоставим по click_slug (мы заранее кладём свой click_id в traffic.clickIds)
    if (!user && click_slug) {
      user = await User.findOne({ "traffic.clickIds": click_slug });
      if (user && telegramId) {
        await User.updateOne({ _id: user._id }, { telegramId });
      }
    }

    // 3) Если нашли — запишем трафик-метки
    if (user) {
      const trafficUpdate = {};
      if (promo_slug) trafficUpdate["traffic.promo_slug"] = promo_slug;
      if (click_slug) {
        trafficUpdate["traffic.click_slug"] = click_slug;
        trafficUpdate.$addToSet = { ...(trafficUpdate.$addToSet || {}), "traffic.clickIds": click_slug };
      }
      if (Object.keys(trafficUpdate).length) {
        await User.updateOne({ _id: user._id }, trafficUpdate);
      }
    }

    // 4) Если пользователя не нашли — возвращаем 200, чтобы Jetton не перестал слать
    if (!user) {
      return res.status(200).send("OK: user_not_found");
    }

    // 5) Идемпотентность по tx_id
    if (tx_id && user.deposits?.lastTxId === tx_id) {
      return res.status(200).send("OK: duplicate_tx_id");
    }

    // 6) Интересуют только депозиты
    const isDepositEvent = action === "first_deposit" || action === "deposit";
    if (!isDepositEvent) {
      return res.status(200).send("OK");
    }

    const usd = Number(amount_usd || 0);

    const update = {
      "deposits.lastTxId": tx_id || null,
      $inc: { "deposits.count": 1, "deposits.totalUsd": usd }
    };

    // 7) Метка первого депозита
    const isFirstByAction = action === "first_deposit";
    if (isFirstByAction && !user.deposits.firstDepositAt) {
      update["deposits.firstDepositAt"] = new Date();
    }

    // 8) Награда за первый депозит (если используешь)
    if (isFirstByAction && !user.rewards?.firstDepositGranted) {
      update.$inc = update.$inc || {};
      update.$inc.balanceTon = FIRST_DEPOSIT_REWARD_USDT; // USDT-эквивалент в твоей модели
      update["rewards.firstDepositGranted"] = true;
      update["rewards.firstDepositAmount"]  = FIRST_DEPOSIT_REWARD_USDT;
    }

    await User.updateOne({ _id: user._id }, update);

    return res.status(200).send("OK");
  } catch (e) {
    console.error("postback error:", e);
    return res.status(200).send("ERROR"); // Jetton обычно не ретраит по 500
  }
});

// ✅ Проверка депозита из БД для кнопки ПРОВЕРИТЬ (Jetton/Mostbet/и др.)
// GET /check-casino-deposit?userId=123&minUsd=5
app.get("/check-casino-deposit", async (req, res) => {
  try {
    const { userId, minUsd } = req.query;
    if (!userId) return res.status(400).json({ ok:false, error: "userId is required" });

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    const count = Number(user.deposits?.count || 0);
    const totalUsd = Number(user.deposits?.totalUsd || 0);
    const firstDepositAt = user.deposits?.firstDepositAt || null;

    // Санитизация minUsd: поддерживаем "5", "5$", "5 дол", "5,5"
    let threshold = null;
    if (minUsd !== undefined && minUsd !== null && String(minUsd).trim() !== "") {
      const cleaned = String(minUsd).trim().replace(",", ".").replace(/[^0-9.]/g, "");
      const parsed = parseFloat(cleaned);
      if (Number.isFinite(parsed) && parsed > 0) threshold = parsed;
    }

    let deposited = false;
    let reason = "";

    if (threshold !== null) {
      deposited = totalUsd >= threshold;
      if (!deposited) reason = `threshold_not_met: totalUsd=${totalUsd}, required=${threshold}`;
    } else {
      // Без порога: любой факт депозита считается достаточным для «первого депозита»
      deposited = count > 0 || totalUsd > 0 || Boolean(firstDepositAt);
      if (!deposited) reason = "no_deposit";
    }

    return res.json({ ok:true, deposited, count, totalUsd, firstDepositAt, minUsd: threshold, reason });
  } catch (e) {
    console.error("❌ /check-casino-deposit error:", e);
    return res.status(500).json({ ok:false, error: "Server error" });
  }
});


// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});