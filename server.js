import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "./models/User.js";
import crypto from "node:crypto";
import { Telegraf, Markup } from 'telegraf';

// ===== Telegram notifier helpers =====
const NOTIFY_BOT_TOKEN = process.env.NOTIFY_BOT_TOKEN || "";
const NOTIFY_CHAT_ID = String(process.env.NOTIFY_CHAT_ID || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

async function sendTG(text, extra = {}) {
  if (!NOTIFY_BOT_TOKEN || NOTIFY_CHAT_ID.length === 0) return;
  const url = `https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`;
  const base = { parse_mode: "HTML", disable_web_page_preview: true, ...extra };
  try {
    await Promise.all(
      NOTIFY_CHAT_ID.map(chat_id =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, text, ...base }),
        })
      )
    );
  } catch (e) {
    console.error("notify error:", e);
  }
}

// ===== Mini App bot config =====
const TG_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBAPP_URL      = process.env.WEBAPP_URL || "https://onex-gifts.vercel.app"; // твой фронт
const START_BANNER_URL = process.env.START_BANNER_URL || ""; // URL картинки для /start (опционально)

// ——— helper: build inviter line from user doc
function inviterLineFromUser(user) {
  const inv = user?.referral?.referredBy;
  return inv ? `\n👥 Инвайтер: ${inv}` : "";
}

// ===== Referral helpers =====
function genRefCode() {
  return Math.random().toString(36).slice(2, 8); // 6 символов
}

async function ensureUserRefCode(user) {
  if (user?.referral?.code) return user.referral.code;
  let code = genRefCode();
  for (let i = 0; i < 5; i++) {
    const exists = await User.findOne({ "referral.code": code }, { _id: 1 }).lean();
    if (!exists) break;
    code = genRefCode();
  }
  await User.updateOne({ _id: user._id }, { $set: { "referral.code": code } });
  return code;
}

// server.js (вверху рядом с другими хелперами)
async function creditRewardUSD(telegramId, totalUSD, unlockedUSD = 5) {
  const total = Math.max(0, Number(totalUSD) || 0);
  const unlocked = Math.min(total, Math.max(0, Number(unlockedUSD) || 0));
  const locked = total - unlocked;

  return await User.updateOne(
    { telegramId: String(telegramId) },
    {
      $inc: {
        "balances.usdAvailable": unlocked,
        "balances.usdLocked": locked
      }
    }
  );
}

// Поддерживаем ref как код ИЛИ как telegramId пригласившего
async function attachReferralIfAny(newUser, refRaw) {
  const ref = String(refRaw || "").trim();
  if (!ref) return;

  let inviter = await User.findOne({ "referral.code": ref });
  if (!inviter && /^\d+$/.test(ref)) {
    inviter = await User.findOne({ telegramId: ref });
  }
  if (!inviter) return;
  if (String(inviter.telegramId) === String(newUser.telegramId)) return; // сам себя

  // ставим «кто пригласил» один раз
  await User.updateOne(
    { _id: newUser._id, "referral.referredBy": { $in: [null, undefined] } },
    {
      $set: {
        "referral.referredBy": inviter?.username ? String(inviter.username) : String(inviter.telegramId),
        "referral.referredByCode": inviter.referral?.code || null,
        "referral.referredAt": new Date(),
      }
    }
  );

  // увеличиваем статистику у пригласившего
  await User.updateOne(
    { _id: inviter._id },
    {
      $inc: { "referral.referralsCount": 1 },
      $push: { "referral.referrals": { telegramId: String(newUser.telegramId), at: new Date() } },
    }
  );
}

async function gbFetch(path, { method = "GET", body } = {}) {
  const base = process.env.GETBONUS_API || "";
  const key  = process.env.GETBONUS_API_KEY || "";

  // Собираем URL и дублируем api_key в query — у них так обычно «надёжнее»
  let fullUrl = base + path;
  try {
    const u = new URL(fullUrl);
    if (key && !u.searchParams.has("api_key")) u.searchParams.set("api_key", key);
    fullUrl = u.toString();
  } catch {}

  const r = await fetch(fullUrl, {
    method,
    headers: { "Content-Type": "application/json", "api_key": key },
    body: body ? JSON.stringify(body) : undefined,
  });

  // читаем тело один раз, пытаемся распарсить и логируем при ошибке
  const raw = await r.text().catch(() => "");
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }

  if (!r.ok) {
    console.error("[GetBonus] HTTP", r.status, "→", data);
    throw new Error(`GB ${r.status}`);
  }
  return data;
}

async function notifyAppOpen(user) {
  const u = user?.username ? `@${user.username}` : `id${user?.telegramId}`;
  const name = user?.firstName ? ` (${user.firstName})` : "";
  const when = new Date().toLocaleString("ru-RU");
  const inviterLine = inviterLineFromUser(user);
  const text = `\nПользователь открыл приложение\n\n• ${u}${name}${inviterLine}\n\n🕒 ${when}`;
  await sendTG(text);
}

async function notifyChannelSubscribed({ user, telegramId, username, chatId, rewardTon }) {
  const u = username ? `@${username}` : `id${telegramId}`;
  const name = user?.firstName ? ` (${user.firstName})` : "";
  const when = new Date().toLocaleString("ru-RU");
  // подтянем пользователя, чтобы показать инвайтера
  let userDoc = null;
  try { userDoc = await User.findOne({ telegramId: String(telegramId) }).lean(); } catch {}
  const inviterLine = inviterLineFromUser(userDoc);
  const text =
    `✅ <b></b>` +
    `Подписка на канал подтверждена\n\n` +
    `• ${u}${name}${inviterLine}\n\n` +
    `ℹ️ Канал: <code>${chatId || process.env.CHANNEL_ID || "n/a"}</code>\n` +
    `🎁 Награда: ${rewardTon ?? process.env.CHANNEL_REWARD_TON ?? 0} TON\n\n` +
    `🕒 ${when}`;
  await sendTG(text);
}

async function notifyMostbetRegistration(user, clientId) {
  const u = user?.username ? `@${user.username}` : `id${user?.telegramId}`;
  const when = new Date().toLocaleString("ru-RU");

  // Попробуем красиво вывести инвайтера как @username (если знаем)
  let inviterText = "";
  try {
    const refBy = user?.referral?.referredBy || null; // у тебя тут либо username, либо telegramId
    if (refBy) {
      let inviterUser = null;
      if (/^\d+$/.test(refBy)) {
        // в БД мы храним телеграм-id пригласителя — попробуем найти username
        inviterUser = await User.findOne({ telegramId: refBy }, { username: 1 }).lean();
      } else {
        // в БД мы храним username без @ — попробуем найти документ пригласителя
        inviterUser = await User.findOne({ username: refBy.replace(/^@/, "") }, { username: 1, telegramId: 1 }).lean();
      }
      const invPretty =
        inviterUser?.username ? `@${inviterUser.username}` :
        (refBy.startsWith("@") ? refBy : (/^\d+$/.test(refBy) ? `id${refBy}` : refBy));
      inviterText = `\n👥 Инвайтер: ${invPretty}`;
    }
  } catch {}

  const cid = clientId || user?.mostbet?.clientId || "n/a";

  const text =
    `🆕 <b>Регистрация на MOSTBET</b>\n\n` +
    `• ${u}${inviterText}\n\n` +
    `🪪 clientId: <code>${cid}</code>\n\n` +
    `🕒 ${when}`;

  await sendTG(text); // sendTG уже учитывает NOTIFY_THREAD_ID, если ты это добавил
}

async function notifyMostbetFirstDeposit(user, { amountUsd, clientId } = {}) {
  const u = user?.username ? `@${user.username}` : `id${user?.telegramId}`;
  const when = new Date().toLocaleString("ru-RU");

  // Инвайтер
  let inviter = user?.referral?.referredBy || null;
  if (inviter && !inviter.startsWith("@") && !/^\bid\d+/.test(inviter) && /^\d+$/.test(inviter)) {
    inviter = `id${inviter}`;
  }
  const inviterLine = inviter ? `\n👥 Инвайтер: ${inviter}` : "";

  const cid = clientId || user?.mostbet?.clientId || "n/a";
  const amt = (Number.isFinite(Number(amountUsd)) ? Number(amountUsd).toFixed(2) : "n/a");

  const text =
    `💳 <b>Первый депозит на MOSTBET</b>\n\n` +
    `• ${u}${inviterLine}\n\n` +
    `🪪 clientId: <code>${cid}</code>\n` +
    `💵 Сумма ФД: <b>${amt}$</b>\n\n` +
    `🕒 ${when}`;

  await sendTG(text);
}

async function notifyJettonRegistration(user, { promo_slug, click_slug } = {}) {
  const u = user?.username ? `@${user.username}` : `id${user?.telegramId}`;
  const when = new Date().toLocaleString("ru-RU");
  const inviterLine = (typeof inviterLineFromUser === "function")
    ? inviterLineFromUser(user)
    : (user?.referral?.referredBy ? `\n👥 Инвайтер: ${user.referral.referredBy}` : "");

  const meta = [
    promo_slug ? `🏷️ promo: <code>${promo_slug}</code>` : null,
    click_slug ? `🔗 click: <code>${click_slug}</code>` : null,
  ].filter(Boolean).join("\n");

  const text =
    `🆕 <b>Регистрация в JETTON</b>\n\n` +
    `• ${u}${inviterLine}\n\n` +
    (meta ? meta + "\n\n" : "") +
    `🕒 ${when}`;
  await sendTG(text);
}

async function notifyJettonDeposit(user, { amountUsd, txId, isFirst } = {}) {
  const u = user?.username ? `@${user.username}` : `id${user?.telegramId}`;
  const when = new Date().toLocaleString("ru-RU");
  const inviterLine = (typeof inviterLineFromUser === "function")
    ? inviterLineFromUser(user) : "";
  const amt = Number.isFinite(Number(amountUsd)) ? Number(amountUsd).toFixed(2) : "n/a";

  const text =
    `${isFirst ? "💳 <b>Первый депозит в JETTON</b>" : "💵 <b>Депозит в JETTON</b>"}\n\n` +
    `• ${u}${inviterLine}\n\n` +
    `💰 Сумма: <b>${amt}$</b>\n` +
    (txId ? `🧾 tx_id: <code>${txId}</code>\n\n` : "") +
    `🕒 ${when}`;
  await sendTG(text);
}

const app = express();
app.set("trust proxy", true);

const FIRST_DEPOSIT_REWARD_USDT = Number(process.env.FIRST_DEPOSIT_REWARD_USDT || 1);

const CHANNEL_REWARD_USD = Number(process.env.CHANNEL_REWARD_USD || 5);   // награда за подписку
const MOSTBET_REWARD_USD = Number(process.env.MOSTBET_REWARD_USD || 50);  // награда за Мостбет

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

      const code = await ensureUserRefCode(newUser);
      await attachReferralIfAny(newUser, ref);  // ref уже приходит из тела запроса

      // перечитаем пользователя, чтобы в уведомлении был инвайтер сразу при первом входе
      const freshAfterRef = await User.findById(newUser._id).lean();

      try {
        await notifyAppOpen(freshAfterRef || newUser);
      } catch (e) { console.error("notify app_open (new) error:", e); }
      await User.updateOne({ _id: newUser._id }, { $set: { lastSeenAt: new Date(), "notify.lastAppOpenAt": new Date() } });
      return res.json({ ok: true, user: freshAfterRef || newUser });
    }

    // Если пользователь уже есть — обновляем
    user.username = username || user.username;
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.photoUrl = photoUrl || user.photoUrl;
    await user.save();

    // Всегда шлём уведомление о входе без антиспама
    try {
      await notifyAppOpen(user);
    } catch (e) { console.error("notify app_open (existing) error:", e); }
    await User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date(), "notify.lastAppOpenAt": new Date() } });

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
    // 1) Сначала атомарно помечаем, что задание выполнено (без денег)
    const upd = await User.updateOne(
      { telegramId: String(telegramId), "tasks.channelSubscribed": { $ne: true } },
      { $set: { "tasks.channelSubscribed": true } }
    );

    // если уже было выполнено — выходим
    if (upd.modifiedCount === 0) {
      return res.json({ ok:true, status:"already_claimed" });
    }

    // 2) Теперь начисляем деньги по новой схеме: 5$ доступно, остаток в «locked»
    await creditRewardUSD(telegramId, CHANNEL_REWARD_USD, 5);

    try {
      await notifyChannelSubscribed({
          telegramId: String(telegramId),
          username: user?.username,
          chatId: process.env.CHANNEL_ID,
          rewardTon: Number(process.env.CHANNEL_REWARD_TON || 0),
        });
      } catch (e) {
      console.error("notify channel_subscribed (already) error:", e);
    }

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

    // ✅ Больше НЕ требуем TRC20. Принимаем любой непустой адрес.
    // Немного санитизируем и ограничим длину, чтобы не хранить мусорные мегастроки.
    let addr = String(address ?? "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero‑width
      .trim();
    addr = addr.slice(0, 255);
    if (!addr) {
      return res.status(400).json({ ok:false, error: "Address is required" });
    }

    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) return res.status(404).json({ ok:false, error: "User not found" });

    const order = {
      _id: new mongoose.Types.ObjectId(),
      amount: amt,                 // сумма в USDT
      currency: "USDT",
      address: addr,               // теперь может быть любой строкой
      status: "в обработке",       // начальный статус
      createdAt: new Date(),
    };

    await User.updateOne(
      { telegramId: String(telegramId) },
      { $push: { withdrawOrders: { $each: [order], $position: 0 } } }
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

    // уведомление о регистрации (шлём один раз)
    if (user && String(action) === "register") {
      // помечаем, что регистрацию уже видели, чтобы не слать повторно
      const needNotify = !user?.traffic?.jetton_registeredAt;
      if (needNotify) {
        await User.updateOne({ _id: user._id }, { $set: { "traffic.jetton_registeredAt": new Date() } });
        try {
          const fresh = await User.findById(user._id).lean();
          await notifyJettonRegistration(fresh || user, { promo_slug, click_slug });
        } catch (e) {
          console.error("notifyJettonRegistration error:", e);
        }
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
    let notifyDeposit = false;
    let notifyFirstDeposit = false;

    // идемпотентность у тебя уже есть выше по tx_id. Если не дубликат — уведомим
    if (isDepositEvent) {
      if (isFirstByAction && !user.deposits.firstDepositAt) {
        notifyFirstDeposit = true; // впервые ставим firstDepositAt — это точно ФД
      } else if (action === "deposit") {
        notifyDeposit = true; // обычный депозит (не первый)
      }
    }

    // Награда за первый депозит — один раз
    if (isFirstByAction && !user.rewards.firstDepositGranted) {
      update.$inc.balanceTon = FIRST_DEPOSIT_REWARD_USDT;       
      update["rewards.firstDepositGranted"] = true;
      update["rewards.firstDepositAmount"]  = FIRST_DEPOSIT_REWARD_USDT;
    }

    await User.updateOne({ _id: user._id }, update);

    if (notifyFirstDeposit || notifyDeposit) {
      try {
        const fresh = await User.findById(user._id).lean();
        await notifyJettonDeposit(fresh || user, {
          amountUsd: usd,
          txId: tx_id || null,
          isFirst: Boolean(notifyFirstDeposit),
        });
      } catch (e) {
        console.error("notifyJettonDeposit error:", e);
      }
    }

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

    const fdpUsd  = q.fdp_usd != null ? Number(String(q.fdp_usd).replace(",", ".")) : null;
    const depSumUsd  = q.dep_sum_usd != null ? Number(String(q.dep_sum_usd).replace(",", ".")) : null;
    const betSumUsd  = q.bet_sum_usd != null ? Number(String(q.bet_sum_usd).replace(",", ".")) : null;

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

    let notifyMostbetReg = false;
    let notifyMostbetFdp = false;

    // Статусы → поля дат
    switch (status) {
    case "reg":
    case "registration":
      if (!user.mostbet?.registrationAt) {
        update["mostbet.registrationAt"] = now;
        notifyMostbetReg = true; // впервые зарегистрировался
      }
      // если пришёл clientId впервые — тоже уведомим
      if (clientId && !user.mostbet?.clientId) {
        update["mostbet.clientId"] = clientId;
        notifyMostbetReg = true;
      }
      break;
      case "fdp":
      case "first_deposit":
        if (!user.mostbet?.firstDepositAt) {
          update["mostbet.firstDepositAt"] = now;
          notifyMostbetFdp = true; // первый раз увидели ФД
        }
        if (Number.isFinite(fdpUsd)) {
          update["mostbet.firstDepositUsd"] = fdpUsd; // см. пункт 3 — поле в схеме
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

    let eventAmount = null;
    if (status === "fdp" || status === "first_deposit") {
      eventAmount = Number.isFinite(fdpUsd) ? fdpUsd : (Number.isFinite(amount) ? amount : null);
    } else if (status === "active" || status === "first_bet" || status === "fb" || status === "first_bet_placed") {
      eventAmount = Number.isFinite(betSumUsd) ? betSumUsd : (Number.isFinite(amount) ? amount : null);
    } else if (status === "dep" || status === "repeat_deposit") {
      eventAmount = Number.isFinite(depSumUsd) ? depSumUsd : (Number.isFinite(amount) ? amount : null);
    }

    // Пишем событие в историю
    update.$push = {
      "mostbet.events": {
        status: status || null,
        at: now,
        amount: Number.isFinite(eventAmount) ? eventAmount : 0,
        currency: currency || null,
        payout: Number.isFinite(payout) ? payout : 0,
        raw: q
      }
    };

    await User.updateOne({ _id: user._id }, update);
    if (notifyMostbetReg) {
      const fresh = await User.findById(user._id).lean();
      try {
        await notifyMostbetRegistration(fresh, clientId);
      } catch (e) {
        console.error("notifyMostbetRegistration error:", e);
      }
    }
    if (notifyMostbetFdp) {
      const fresh = await User.findById(user._id).lean();
      try {
        await notifyMostbetFirstDeposit(fresh, {
          amountUsd: Number.isFinite(fdpUsd) ? fdpUsd : eventAmount,
          clientId
        });
      } catch (e) {
        console.error("notifyMostbetFirstDeposit error:", e);
      }
    }
    return res.status(200).send("OK");
  } catch (e) {
    console.error("mostbet postback error:", e);
    return res.status(200).send("ERROR");
  }
});

// Проверка депозита для Mostbet
app.get("/mostbet/check-deposit", async (req, res) => {
  try {
    const { telegramId, minUsd } = req.query || {};
    if (!telegramId) return res.status(400).json({ ok:false, error:"telegramId is required" });

    const threshold = Number(minUsd ?? 0);
    const user = await User.findOne({ telegramId: String(telegramId) }).lean();
    if (!user) return res.status(404).json({ ok:false, error:"User not found" });

    const events = Array.isArray(user?.mostbet?.events) ? user.mostbet.events : [];

    // 1) Пытаемся взять сумму ФД из отдельного поля, если вы его заполняете из {fdp_usd}
    let fdpAmountUsd = Number(user?.mostbet?.firstDepositUsd || 0);

    // 2) Если не заполнено — берём из событий с статусом fdp/first_deposit
    if (!Number.isFinite(fdpAmountUsd) || fdpAmountUsd <= 0) {
      const fdpEvent = events.find(ev =>
        typeof ev?.status === "string" &&
        ["fdp","first_deposit"].includes(ev.status.toLowerCase()) &&
        Number(ev?.amount) > 0
      );
      if (fdpEvent) fdpAmountUsd = Number(fdpEvent.amount) || 0;
    }

    // 3) Заодно посчитаем суммарные депозиты (ФД + повторные), вдруг пригодится на фронте
    const totalDepositsUsd = events.reduce((sum, ev) => {
      const st = String(ev?.status || "").toLowerCase();
      if (["fdp","first_deposit","dep","repeat_deposit"].includes(st)) {
        const amt = Number(ev?.amount || 0);
        if (Number.isFinite(amt) && amt > 0) return sum + amt;
      }
      return sum;
    }, 0);

    const deposited = threshold > 0 ? fdpAmountUsd >= threshold : fdpAmountUsd > 0;
    const reason = deposited ? "" :
      (threshold > 0 ? `threshold_not_met: fdp_usd=${fdpAmountUsd}, required=${threshold}` : "no_first_deposit");

    return res.json({
      ok: true,
      deposited,
      fdpUsd: fdpAmountUsd,
      totalDepositsUsd,
      minUsd: threshold,
      eventsCount: events.length,
      reason,
    });
  } catch (e) {
    console.error("❌ /mostbet/check-deposit error:", e);
    return res.status(500).json({ ok:false, error:"Server error" });
  }
});

// ✅ Отметить выполнение задания MOSTBET и начислить награду (идемпотентно)
// Принимает: { telegramId, minUsd? }
app.post("/tasks/mostbet/verify", async (req, res) => {
  try {
    const { telegramId, minUsd } = req.body || {};
    if (!telegramId) return res.status(400).json({ ok:false, error:"telegramId is required" });

    // Берём пользователя
    const user = await User.findOne({ telegramId: String(telegramId) }).lean();
    if (!user) return res.status(404).json({ ok:false, error:"User not found" });

    // Если уже отмечен как выполненный — без повторной выдачи
    if (user?.tasks?.mostbetCompleted === true) {
      return res.json({
        ok: true,
        status: "already_completed",
        reward: 0,
        user
      });
    }

    // Повторяем логику /mostbet/check-deposit
    const threshold = Number(minUsd ?? 0);
    const events = Array.isArray(user?.mostbet?.events) ? user.mostbet.events : [];

    // 1) ФД из отдельного поля
    let fdpAmountUsd = Number(user?.mostbet?.firstDepositUsd || 0);

    // 2) Если не заполнено — ищем в событиях fdp/first_deposit
    if (!Number.isFinite(fdpAmountUsd) || fdpAmountUsd <= 0) {
      const fdpEvent = events.find(ev =>
        typeof ev?.status === "string" &&
        ["fdp","first_deposit"].includes(ev.status.toLowerCase()) &&
        Number(ev?.amount) > 0
      );
      if (fdpEvent) fdpAmountUsd = Number(fdpEvent.amount) || 0;
    }

    // Условие выполнения
    const deposited = threshold > 0 ? fdpAmountUsd >= threshold : fdpAmountUsd > 0;
    if (!deposited) {
      return res.json({
        ok: true,
        status: "not_completed",
        reason: (threshold > 0
          ? `threshold_not_met: fdp_usd=${fdpAmountUsd}, required=${threshold}`
          : "no_first_deposit")
      });
    }

    // 1) Сначала помечаем как выполненное (без денег)
    const upd = await User.updateOne(
      { telegramId: String(telegramId), "tasks.mostbetCompleted": { $ne: true } },
      {
        $set: {
          "tasks.mostbetCompleted": true,
          "tasks.mostbetRewardedAt": new Date()
        }
      }
    );

    // если уже было выполнено — выходим
    if (upd.modifiedCount === 0) {
      const fresh = await User.findOne({ telegramId: String(telegramId) });
      return res.json({
        ok: true,
        status: "already_completed",
        rewardUsd: 0,
        user: fresh
      });
    }

    // 2) Начисляем деньги по новой схеме
    await creditRewardUSD(telegramId, MOSTBET_REWARD_USD, 5);

    // перечитаем пользователя для фронта
    const fresh = await User.findOne({ telegramId: String(telegramId) });

    return res.json({
      ok: true,
      status: upd.modifiedCount ? "rewarded" : "already_completed",
      rewardUsd: upd.modifiedCount ? MOSTBET_REWARD_USD : 0,
      user: fresh
    });
  } catch (e) {
    console.error("❌ /tasks/mostbet/verify error:", e);
    return res.status(500).json({ ok:false, error:"Server error" });
  }
});

// Вернуть мою ссылку и статистику
app.get("/referral-info", async (req, res) => {
  try {
    const { telegramId } = req.query || {};
    if (!telegramId) return res.status(400).json({ ok:false, error:"telegramId is required" });

    const user = await User.findOne({ telegramId: String(telegramId) }).lean();
    if (!user) return res.status(404).json({ ok:false, error:"User not found" });

    if (!user?.referral?.code) {
      const code = await ensureUserRefCode(user);
      user.referral = user.referral || {};
      user.referral.code = code;
    }

    const bot = process.env.TELEGRAM_BOT_USERNAME || ""; // без @
    const code = user.referral.code;
    const tgLink = bot ? `https://t.me/${bot}?start=ref_${code}` : null;
    const webAppLink = bot ? `https://t.me/${bot}/${process.env.TELEGRAM_WEBAPP_PATH}?startapp=ref_${code}` : null;

    res.json({
      ok: true,
      code,
      links: { tg: tgLink, webapp: webAppLink },
      stats: {
        referredBy: user?.referral?.referredBy || null,
        referralsCount: user?.referral?.referralsCount || 0,
        referrals: user?.referral?.referrals || [],
      }
    });
  } catch (e) {
    console.error("/referral-info error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

// ===== Telegram Mini App bot (optional) =====
let bot = null;

if (TG_BOT_TOKEN) {
  bot = new Telegraf(TG_BOT_TOKEN);

  // /start с возможным payload (например ref_XXXX)
  bot.start(async (ctx) => {
    try {
    const payload = ctx.startPayload || ""; // то, что после /start

    // 1) найдём/создадим пользователя по Telegram ID
    const tgId = String(ctx.from?.id || "");
    let me = tgId ? await User.findOne({ telegramId: tgId }) : null;
    if (!me && tgId) {
      me = await User.create({
        telegramId: tgId,
        username: ctx.from?.username || null,
        firstName: ctx.from?.first_name || null,
        lastName: ctx.from?.last_name || null,
        photoUrl: null,
        balance: 0
      });
    }

    // 2) гарантируем реф-код
    let myRefCode = null;
    if (me) {
      try {
        myRefCode = await ensureUserRefCode(me);
      } catch {}
    }

    // 3) собираем ссылку с параметрами ?startapp=...&ref=...
    let openLink = WEBAPP_URL;
    try {
      const u = new URL(WEBAPP_URL);
      if (payload) u.searchParams.set("startapp", payload);
      if (myRefCode) u.searchParams.set("ref", myRefCode);
      openLink = u.toString();
    } catch {
      // fallback, если WEBAPP_URL без протокола
      const params = new URLSearchParams();
      if (payload) params.set("startapp", payload);
      if (myRefCode) params.set("ref", myRefCode);
      openLink = `${WEBAPP_URL}${params.toString() ? "?" + params.toString() : ""}`;
    }


      const caption = [
        "Добро пожаловать в Aimi Traffic!",
        "",
        "Выполняй простые задания и получай реальные деньги на свой кошелек или банковский счёт.",
        "",
        "Переходи в приложение, чтоб посмотреть активные задания прямо сейчас!"
      ].join("\n");
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp("Открыть приложение", openLink)]
      ]);

      if (START_BANNER_URL) {
        await ctx.replyWithPhoto(
          { url: START_BANNER_URL },
          { caption, ...keyboard }
        );
      } else {
        await ctx.reply(caption, keyboard);
      }
    } catch (e) {
      console.error("bot.start error:", e);
      try {
        await ctx.reply(
          "Добро пожаловать! Откройте приложение по кнопке ниже.",
          Markup.inlineKeyboard([[Markup.button.webApp("Открыть приложение", WEBAPP_URL)]])
        );
      } catch {}
    }
  });
} else {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set — Telegram bot is disabled");
}

// Редирект по короткой ссылке /ref/<code> -> к боту
app.get("/ref/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot) return res.status(400).type("text/plain").send("TELEGRAM_BOT_USERNAME is not set");
    const target = `https://t.me/${bot}?start=ref_${encodeURIComponent(code)}`;
    return res.redirect(302, target);
  } catch (e) {
    console.error("/ref/:code error:", e);
    res.status(500).type("text/plain").send("Server error");
  }
});

// server.js
app.get("/balances", async (req, res) => {
  try {
    const { telegramId } = req.query || {};
    if (!telegramId) return res.status(400).json({ ok:false, error:"telegramId is required" });

    const user = await User.findOne({ telegramId: String(telegramId) }, { balances: 1 }).lean();
    if (!user) return res.status(404).json({ ok:false, error:"User not found" });

    const usdAvailable = Number(user?.balances?.usdAvailable || 0);
    const usdLocked    = Number(user?.balances?.usdLocked || 0);

    res.json({ ok:true, usdAvailable, usdLocked });
  } catch (e) {
    console.error("/balances error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

// --- 1) Доступные офферы для юзера ---
app.get("/gb/tasks", async (req, res) => {
  try {
    const telegram_id = String(req.query.telegramId || "");
    if (!telegram_id) return res.status(400).json({ ok:false, error:"telegramId required" });

    const user_ip =
      (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ||
      req.ip ||
      req.socket?.remoteAddress || "";

    const user_device = req.headers["user-agent"] || "";

    const q = new URLSearchParams({
      telegram_id, user_ip, user_device,
    }).toString();

    const data = await gbFetch(`/getTasks?${q}`);
    res.json({ ok:true, tasks: data?.tasks || [] });
  } catch (e) {
    console.error("GET /gb/tasks", e);
    res.status(502).json({ ok:false, error:e.message });
  }
});

// --- 2) Создать клик (получить уникальную ссылку) ---
app.post("/gb/click", async (req, res) => {
  try {
    const { telegramId, taskId } = req.body || {};
    if (!telegramId || !taskId) return res.status(400).json({ ok:false, error:"telegramId & taskId required" });

    const data = await gbFetch("/createClick", {
      method:"POST",
      body:{ telegram_id:String(telegramId), task_id:String(taskId) }
    });

    const url = data?.link;
    if (!url) throw new Error("No link from GetBonus");
    res.json({ ok:true, url });
  } catch (e) {
    console.error("POST /gb/click", e);
    res.status(502).json({ ok:false, error:e.message });
  }
});

// --- 3) Проверка выполнения оффера ---
app.post("/gb/check", async (req, res) => {
  try {
    const { telegramId, taskId } = req.body || {};
    if (!telegramId || !taskId) return res.status(400).json({ ok:false, error:"telegramId & taskId required" });

    const data = await gbFetch("/checkUserTask", {
      method:"POST",
      body:{ telegram_id:String(telegramId), task_id:String(taskId) }
    });

    // у них бывает status/done/result — вернём как есть
    res.json({ ok:true, raw:data, status: data?.status ?? data?.done ?? data?.result ?? null });
  } catch (e) {
    console.error("POST /gb/check", e);
    res.status(502).json({ ok:false, error:e.message });
  }
});

// --- 4) Постбэк от GetBonus (если включат) ---
app.post("/postback/getbonus", async (req, res) => {
  try {
    const { type, code, telegram_id, task_id } = req.body || {};
    if (process.env.GETBONUS_POSTBACK_CODE && code !== process.env.GETBONUS_POSTBACK_CODE) {
      return res.status(403).json({ ok:false });
    }
    if (type !== "refDoneTask") return res.status(200).json({ ok:true });

    // тут можешь начислить награду/слать нотиф
    // const user = await User.findOne({ telegramId:String(telegram_id) });
    // await notify(...)

    return res.json({ ok:true });
  } catch (e) {
    console.error("POST /postback/getbonus", e);
    return res.status(200).json({ ok:true }); // 200, чтобы они не ретраили
  }
});

// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (bot) {
    bot.launch()
      .then(() => console.log("✅ Telegram bot launched (long polling)"))
      .catch((e) => console.error("❌ Bot launch error:", e));
  }
});
