import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: String, index: true, unique: true }, // ключевой ID
    firstName: String,
    lastName: String,
    username: String,
    languageCode: String,
    photoUrl: String
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);