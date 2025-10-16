import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "./models/User.js";
import crypto from "node:crypto";

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

    // Найдём пользователя по telegramId (предпочтительно)
    const telegramId = (player_telegram_id && player_telegram_id !== "0")
      ? String(player_telegram_id)
      : null;

    let user = telegramId ? await User.findOne({ telegramId }) : null;

    // ДОБАВЬ ЭТО
    if (!user && click_slug) {
      const m = String(click_slug).match(/^tg_(\d+)/);
      if (m && m[1]) {
        user = await User.findOne({ telegramId: m[1] });
      }
    }

    // Если нашли — можно обновить трафик-поля (по желанию):
    if (user) {
      const trafficUpdate = {};
      if (promo_slug) trafficUpdate["traffic.promo_slug"] = promo_slug;
      if (click_slug) trafficUpdate["traffic.click_slug"] = click_slug;
      if (Object.keys(trafficUpdate).length) {
        await User.updateOne({ _id: user._id }, trafficUpdate);
      }
    }

    // Если юзер не найден, можно тихо завершить (OK) или создать аккаунт.
    if (!user) {
      return res.status(200).send("OK: user_not_found");
    }

    // Идемпотентность: если приходил такой tx_id — повтор не обрабатываем.
    if (tx_id && user.deposits?.lastTxId === tx_id) {
      return res.status(200).send("OK: duplicate_tx_id");
    }

    // Интересны только события депозита
    const isDepositEvent = action === "first_deposit" || action === "deposit";
    if (!isDepositEvent) {
      // Можно логировать register/withdraw, если надо
      return res.status(200).send("OK");
    }

    const usd = Number(amount_usd || 0);

    // Базовое обновление агрегатов депозитов
    const update = {
      "deposits.lastTxId": tx_id || null,
      $inc: { "deposits.count": 1, "deposits.totalUsd": usd }
    };

    // Если это первый депозит — поставим дату первого депозита
    const isFirstByAction = action === "first_deposit";
    if (isFirstByAction && !user.deposits.firstDepositAt) {
      update["deposits.firstDepositAt"] = new Date();
    }

    // Награда за первый депозит — один раз
    if (isFirstByAction && !user.rewards.firstDepositGranted) {
      update.$inc.balanceTon = FIRST_DEPOSIT_REWARD_USDT;       
      update["rewards.firstDepositGranted"] = true;
      update["rewards.firstDepositAmount"]  = FIRST_DEPOSIT_REWARD_USDT;
    }

    await User.updateOne({ _id: user._id }, update);

    return res.status(200).send("OK");
  } catch (e) {
    console.error("postback error:", e);
    return res.status(200).send("ERROR"); 
  }
});


app.post("/rewards/first-deposit/reconcile", async (req, res) => {
  try {
    const { telegramId } = req.body || {};
    if (!telegramId) return res.status(400).json({ ok:false, error:"telegramId is required" });

    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ ok:false, error:"User not found" });

    if (user.rewards?.firstDepositGranted) {
      return res.json({ ok:true, status:"already_granted", user });
    }

    const hadAnyDeposit =
      Boolean(user.deposits?.firstDepositAt) ||
      (Number(user.deposits?.count || 0) > 0) ||
      (Number(user.deposits?.totalUsd || 0) > 0);

    if (!hadAnyDeposit) {
      // депозита не видим — ничего не начисляем
      return res.json({ ok:true, status:"no_deposit_detected" });
    }

    // идемпотентное начисление
    const upd = await User.updateOne(
      { _id: user._id, "rewards.firstDepositGranted": { $ne: true } },
      {
        $inc: { balanceTon: FIRST_DEPOSIT_REWARD_USDT },
        $set: {
          "rewards.firstDepositGranted": true,
          "rewards.firstDepositAmount": FIRST_DEPOSIT_REWARD_USDT,

          "deposits.firstDepositAt": user.deposits?.firstDepositAt || new Date()
        }
      }
    );

    if (upd.modifiedCount === 0) {
      return res.json({ ok:true, status:"already_granted" });
    }

    const fresh = await User.findOne({ _id: user._id });
    return res.json({ ok:true, status:"granted", reward: FIRST_DEPOSIT_REWARD_USDT, user: fresh });
  } catch (e) {
    console.error("/rewards/first-deposit/reconcile error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});


app.get("/check-casino-deposit", async (req, res) => {
  try {
    const { userId, minUsd } = req.query;
    if (!userId) return res.status(400).json({ ok:false, error: "userId is required" });

    const user = await User.findOne({ telegramId: String(userId) });
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    const count = Number(user.deposits?.count || 0);
    const totalUsd = Number(user.deposits?.totalUsd || 0);
    const firstDepositAt = user.deposits?.firstDepositAt || null;

    // Жёсткая проверка порога: если он задан (>0), требуем totalUsd >= minUsd
    const threshold = (minUsd !== undefined && minUsd !== null && String(minUsd).trim() !== "")
      ? Number(minUsd)
      : null;

    let deposited;
    let reason = "";

    if (threshold !== null && Number.isFinite(threshold) && threshold > 0) {
      deposited = totalUsd >= threshold;
      if (!deposited) {
        reason = `threshold_not_met: totalUsd=${totalUsd}, required=${threshold}`;
      }
    } else {
      // Без порога: считаем депозит свершившимся по любому из признаков
      deposited = count > 0 || totalUsd > 0 || Boolean(firstDepositAt);
      if (!deposited) {
        reason = "no_deposit";
      }
    }

    return res.json({ ok: true, deposited, count, totalUsd, firstDepositAt, minUsd: threshold, reason });
  } catch (e) {
    console.error("❌ /check-casino-deposit error:", e);
    return res.status(500).json({ ok:false, error: "Server error" });
  }
});


// ===== MOSTBET POSTBACK =====
// Ожидаем в query: status, subid/sub1/s1/aff_sub (ваш userId), client_id, click_id,
// а также необязательные amount, currency, payout, landing, project
app.get("/postback/mostbet", async (req, res) => {
  try {
    console.log("[MOSTBET] raw:", req.originalUrl);
    const q = req.query || {};

    const status   = String(q.status || q.event || "").toLowerCase();
    const subid    = String(q.subid  || q.sub1 || q.s1 || q.aff_sub || "").trim();
    const clientId = q.client_id ? String(q.client_id) : null;
    const clickId  = q.click_id  ? String(q.click_id)  : null;
    const landing  = q.landing   ? String(q.landing)   : null;
    const project  = q.project   ? String(q.project)   : null;

    const amount   = q.amount != null ? Number(String(q.amount).replace(",", ".")) : null;
    const payout   = q.payout != null ? Number(String(q.payout).replace(",", ".")) : null;
    const currency = q.currency ? String(q.currency) : null;

    // userId обязателен — ты передаёшь его в ссылке как ?sub1={telegramId}
    if (!subid) return res.status(200).send("OK: no_subid");

    const user = await User.findOne({ telegramId: subid });
    if (!user) return res.status(200).send("OK: user_not_found");

    // Идемпотентность: один и тот же постбэк не обрабатываем повторно
    const sig = crypto.createHash("sha1").update(req.originalUrl).digest("hex");
    if (user.mostbet?.lastSig === sig) {
      return res.status(200).send("OK: duplicate");
    }

    const now = new Date();
    const update = {
      "mostbet.lastSig": sig,
      "mostbet.lastStatus": status || user.mostbet?.lastStatus || null,
      "mostbet.lastAt": now,
    };

    if (clientId) update["mostbet.clientId"] = clientId;
    if (clickId)  update["mostbet.clickId"]  = clickId;

    // Лёгкие трафик-метки
    if (landing) update["traffic.mostbet_landing"] = landing;
    if (project) update["traffic.mostbet_project"] = project;
    if (clickId) update["traffic.mostbet_click_id"] = clickId;

    // Статусы → поля дат
    switch (status) {
      case "reg":
      case "registration":
        if (!user.mostbet?.registrationAt) {
          update["mostbet.registrationAt"] = now;
        }
        break;
      case "fdp":
      case "first_deposit":
        if (!user.mostbet?.firstDepositAt) {
          update["mostbet.firstDepositAt"] = now;
        }
        break;
      case "first_bet":
      case "fb":
      case "first_bet_placed":
        if (!user.mostbet?.firstBetAt) {
          update["mostbet.firstBetAt"] = now;
        }
        break;
      default:
        // другие статусы просто запишем в историю
        break;
    }

    // Пишем событие в историю
    update.$push = {
      "mostbet.events": {
        status: status || null,
        at: now,
        amount: Number.isFinite(amount) ? amount : 0,
        currency: currency || null,
        payout: Number.isFinite(payout) ? payout : 0,
        raw: q
      }
    };

    await User.updateOne({ _id: user._id }, update);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("mostbet postback error:", e);
    return res.status(200).send("ERROR");
  }
});

// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});