import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "./models/User.js";

const app = express();

app.use(cors());
app.use(express.json());

// ✅ Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ✅ Проверка
app.get("/ping", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.type("text/plain").send("OK"));
app.get("/tasks/channel/verify", (_req, res) => res.status(405).json({ ok:false, error:"Use POST" }));
app.post("/tasks/channel/verify", (_req, res) => res.json({ ok:true, status:"stub" }));

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

// ✅ Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});