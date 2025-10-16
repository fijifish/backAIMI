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

    traffic: {
      promo_slug:   { type: String, default: null },   // {promo_slug}
      click_slug:   { type: String, default: null },   // {click_slug}
      click_params: { type: mongoose.Schema.Types.Mixed, default: {} }, // любые ?sub_id_*
    },

    deposits: {
      firstDepositAt: { type: Date, default: null },     // время первого успешного депозита
      count:          { type: Number, default: 0 },       // всего успешных депозитов
      totalUsd:       { type: Number, default: 0 },       // суммарно в USD
      lastTxId:       { type: String, default: null },    // для идемпотентности
    },

    rewards: {
      firstDepositGranted: { type: Boolean, default: false }, // награда за первый депозит выдана
      firstDepositAmount:  { type: Number, default: 0 },      // размер награды (USDT)
    },

  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);