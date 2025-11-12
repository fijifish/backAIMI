
import mongoose from "mongoose";

// State for GetBonus tasks
const GbTaskStateSchema = new mongoose.Schema({
  done:      { type: Boolean, default: false }, // засчитано и выдана награда
  at:        { type: Date,    default: null },  // когда засчитали
  rewardUsd: { type: Number,  default: 0 },     // сколько начислили
  clicks:    { type: Number,  default: 0 },     // сколько раз создавали клик
}, { _id: false });


const userSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    username:   { type: String, default: null },
    firstName:  { type: String, default: null },
    lastName:   { type: String, default: null },
    photoUrl:   { type: String, default: null },

    balanceTon: { type: Number, default: 0 },

      balances: {
        usdAvailable: { type: Number, default: 0 }, // доступно к выводу
        usdLocked:    { type: Number, default: 0 }, // заблокировано до выполнения всех задач
      },

    tasks: {
      channelSubscribed: { type: Boolean, default: false },
      mostbetCompleted:  { type: Boolean, default: false },
      mostbetRewardedAt: { type: Date,    default: null },
      onexReferralDone:  { type: Boolean, default: false },
      onexReferralAt:    { type: Date,    default: null },

      // Карта состояний задач GetBonus: ключ = taskId (строка/число), значение = GbTaskStateSchema
      gb: {
        type: Map,
        of: GbTaskStateSchema,
        default: undefined
      }
    },

    lastSeenAt: { type: Date, default: null },
    notify: {
      lastAppOpenAt: { type: Date, default: null }, // когда последний раз слали «зашёл в приложение»
    },

    referral: {
      code:           { type: String, default: null }, // уникальный код
      referredBy:     { type: String, default: null },               // telegramId пригласившего
      referredByCode: { type: String, default: null },               // его код (копия)
      referredAt:     { type: Date,   default: null },

      referralsCount: { type: Number, default: 0 },
      referrals: [
        new mongoose.Schema({
          telegramId: { type: String },
          at:         { type: Date, default: Date.now },
        }, { _id: false })
      ],
    },


    withdrawOrders: [
    {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: false },
        amount: Number,               // USDT
        currency: { type: String, default: "USDT" },
        address: String,              // TRC20
        status: { type: String, default: "в обработке" }, // "выполнен" | "отклонён"
        createdAt: { type: Date, default: Date.now },
        payType:   { type: String },
        payMethod: { type: String },
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


    mostbet: {
      clientId:       { type: String, default: null },   // ID игрока у Mostbet (client_id)
      clickId:        { type: String, default: null },   // click_id (если присылают)
      registrationAt: { type: Date,   default: null },   // дата регистрации
      firstDepositAt: { type: Date,   default: null },   // дата первого депозита
      firstDepositUsd: { type: Number, default: 0 },   
      firstBetAt:     { type: Date,   default: null },   // дата первой ставки
      lastStatus:     { type: String, default: null },   // последний статус из постбэка
      lastAt:         { type: Date,   default: null },   // когда пришёл последний статус
      lastSig:        { type: String, default: null },   // идемпотентность (хэш исходного запроса)
      events: [
        new mongoose.Schema({
          status:   { type: String },                    // reg | fdp | first_bet | ...
          at:       { type: Date,   default: Date.now }, // время получения события
          amount:   { type: Number, default: 0 },        // опционально (если шлют)
          currency: { type: String, default: null },
          payout:   { type: Number, default: 0 },        // опционально (если шлют)
          raw:      { type: mongoose.Schema.Types.Mixed, default: {} } // полный query их запроса
        }, { _id: false })
      ]
    },
  }, { timestamps: true }



);

// Уникальный индекс на referral.code (sparse позволяет множеству null)
userSchema.index({ "referral.code": 1 }, { unique: true, sparse: true });

export default mongoose.model("User", userSchema);