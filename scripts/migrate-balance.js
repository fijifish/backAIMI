// scripts/migrate-balance.js
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

await mongoose.connect(process.env.MONGODB_URI);

const users = await User.find({ balanceTon: { $gt: 0 } });
for (const u of users) {
  // пример: всё кладём в доступный (или по своей логике — в locked)
  const amt = Number(u.balanceTon || 0);
  u.balances = u.balances || {};
  u.balances.usdAvailable = Number(u.balances.usdAvailable || 0) + amt;
  u.balanceTon = 0; // обнулим Legacy
  await u.save();
  console.log("migrated", u.telegramId, amt);
}

await mongoose.disconnect();
console.log("done");