import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    username:   { type: String, default: null },
    firstName:  { type: String, default: null },
    lastName:   { type: String, default: null },
    photoUrl:   { type: String, default: null }
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);