import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    username:   { type: String, default: null },
    firstName:  { type: String, default: null },
    lastName:   { type: String, default: null },
    photoUrl:   { type: String, default: null },

    balanceTon: { type: Number, default: 0 },

    tasks: {
      channelSubscribed: { type: Boolean, default: false },
    },

    withdrawOrders: [
    {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: false },
        amount: Number,               // USDT
        currency: { type: String, default: "USDT" },
        address: String,              // TRC20
        status: { type: String, default: "в обработке" }, // "выполнен" | "отклонён"
        createdAt: { type: Date, default: Date.now }
    }
    ],
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);