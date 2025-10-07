import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import User from "./models/User.js";

const app = express();

// ✅ Настройки CORS — впиши сюда домен своего фронта
const allowedOrigins = [
  "https://moonlit-sunshine-36a99e.netlify.app",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked for this origin"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "1mb" }));

// ✅ Healthcheck
app.get("/ping", (_, res) => res.json({ ok: true }));

// ✅ Подключение к MongoDB Atlas
const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI, {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 8000
})
.then(() => console.log("✅ MongoDB connected"))
.catch((err) => console.error("❌ MongoDB connection error:", err.message));

// ✅ Основной эндпоинт — сохраняет или обновляет пользователя
app.post("/register-user", async (req, res) => {
  try {
    const { telegramId, username, firstName, lastName, photoUrl } = req.body || {};

    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId is required" });
    }

    const user = await User.findOneAndUpdate(
      { telegramId: String(telegramId) },
      {
        username: username ?? null,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        photoUrl: photoUrl ?? null
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: user.photoUrl
      }
    });
  } catch (error) {
    console.error("❌ register-user error:", error);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Запуск сервера
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});