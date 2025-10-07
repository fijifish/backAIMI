import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import crypto from "crypto";
import User from "./models/User.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// проверка initData (WebAppData)
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return null;
  urlParams.delete("hash");

  const dataCheckString = Array.from(urlParams.keys())
    .sort()
    .map((k) => `${k}=${urlParams.get(k)}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calcHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calcHash !== hash) return null;

  try {
    const userJson = urlParams.get("user");
    return userJson ? JSON.parse(userJson) : null;
  } catch {
    return null;
  }
}

await mongoose.connect(process.env.MONGODB_URI);

// upsert + вернуть пользователя
app.post("/api/auth/upsert", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const verified = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!verified?.id) {
      return res.status(401).json({ ok: false, error: "Invalid initData" });
    }

    const doc = await User.findOneAndUpdate(
      { telegramId: String(verified.id) },
      {
        firstName: verified.first_name || null,
        lastName: verified.last_name || null,
        username: verified.username || null,
        languageCode: verified.language_code || null,
        photoUrl: verified.photo_url || null
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      user: {
        telegramId: doc.telegramId,
        firstName: doc.firstName,
        lastName: doc.lastName,
        username: doc.username,
        languageCode: doc.languageCode,
        photoUrl: doc.photoUrl
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`API listening on http://localhost:${process.env.PORT}`);
});