// bonusRouter.js — Referral & Bonus Partnership Routes

const express = require("express");
const router  = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { connectToDatabase } = require("./lib/db");

const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

/* ---------- auth middleware (cookie + query-param, same as other routers) ---------- */
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized: Please login." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired: Please re-authenticate." });
  }
}

/* ---------- Member schema & model ----------
   One row per platform-user. Tracks the referral-programme identity separately
   from the main User auth record so it can store a phone number, its own
   referral-commission wallet balance, and a unique referral code.
---------------------------------------------------------- */
const MemberSchema = new mongoose.Schema({
  userId:            { type: String, required: true, unique: true }, // User._id as string
  username:          { type: String, required: true },               // NS-platform login username
  fullName:          { type: String, required: true },               // "Real Names" from the form
  phoneNumber:       { type: String, required: true, unique: true }, // 10-digit phone
  walletBalance:     { type: Number, default: 0 },                   // referral-commission earnings (FRW)
  totalReferredUsers:{ type: Number, default: 0 },                   // how many referrals converted
  referralCode:      { type: String, required: true, unique: true }, // auto-generated token
  createdAt:         { type: Date,   default: Date.now }
});
const Member = mongoose.models.Member || mongoose.model("Member", MemberSchema);

/* ---------- helpers ---------- */
function makeReferralCode(username) {
  const prefix = username.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const rand   = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${rand}`;
}

async function uniqueCode(username) {
  let code, tries = 0;
  do {
    code = makeReferralCode(username);
    tries++;
  } while ((await Member.findOne({ referralCode: code })) && tries < 15);
  return code;
}

/* ================================================================
   GET /api/bonus/my-profile
   Returns the member record for the logged-in user.
   Used by the frontend on every page load for session persistence.
================================================================= */
router.get("/api/bonus/my-profile", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const User   = mongoose.model("User");
    const lookup = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookup });
    if (!dbUser) return res.status(404).json({ error: "User account not found." });

    const member = await Member.findOne({ userId: dbUser._id.toString() });
    if (!member) return res.json({ registered: false });

    return res.json({
      registered:         true,
      username:           member.username,
      fullName:           member.fullName,
      phoneNumber:        member.phoneNumber,
      walletBalance:      member.walletBalance,
      totalReferredUsers: member.totalReferredUsers,
      referralCode:       member.referralCode
    });
  } catch (err) {
    console.error("[Bonus] my-profile error:", err);
    return res.status(500).json({ error: "Profile fetch failed." });
  }
});

/* ================================================================
   POST /api/bonus/register-partner
   Registers the logged-in user as a referral-programme member.
   - If they are already registered → return their existing record.
   - If phone is taken by another user → 409.
   - Otherwise → create record, return data.
================================================================= */
router.post("/api/bonus/register-partner", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const { realNames, telephone } = req.body;

    if (!realNames || !telephone) {
      return res.status(400).json({ error: "Full name and telephone are required." });
    }
    if (!/^\d{10}$/.test(telephone.trim())) {
      return res.status(400).json({ error: "Telephone must be exactly 10 digits." });
    }

    const User   = mongoose.model("User");
    const lookup = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookup });
    if (!dbUser) return res.status(404).json({ error: "User account not found." });

    const userId = dbUser._id.toString();

    // Already registered — return existing record
    const existing = await Member.findOne({ userId });
    if (existing) {
      return res.json({
        registered:         true,
        alreadyExists:      true,
        username:           existing.username,
        fullName:           existing.fullName,
        phoneNumber:        existing.phoneNumber,
        walletBalance:      existing.walletBalance,
        totalReferredUsers: existing.totalReferredUsers,
        referralCode:       existing.referralCode
      });
    }

    // Phone already taken by another member
    const phoneTaken = await Member.findOne({ phoneNumber: telephone.trim() });
    if (phoneTaken) {
      return res.status(409).json({ error: "This phone number is already registered by another member." });
    }

    const referralCode = await uniqueCode(dbUser.username);

    const newMember = await Member.create({
      userId,
      username:           dbUser.username,
      fullName:           realNames.trim(),
      phoneNumber:        telephone.trim(),
      walletBalance:      0,
      totalReferredUsers: 0,
      referralCode
    });

    return res.status(201).json({
      registered:         true,
      username:           newMember.username,
      fullName:           newMember.fullName,
      phoneNumber:        newMember.phoneNumber,
      walletBalance:      newMember.walletBalance,
      totalReferredUsers: newMember.totalReferredUsers,
      referralCode:       newMember.referralCode
    });

  } catch (err) {
    console.error("[Bonus] register-partner error:", err);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

/* ================================================================
   POST /api/bonus/generate-code
   Returns the referral code for an already-registered member.
   Kept for backwards-compatibility with the frontend button.
================================================================= */
router.post("/api/bonus/generate-code", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const User   = mongoose.model("User");
    const lookup = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookup });
    if (!dbUser) return res.status(404).json({ error: "User account not found." });

    const member = await Member.findOne({ userId: dbUser._id.toString() });
    if (!member) {
      return res.status(404).json({ error: "Please register as a member first before generating a code." });
    }

    return res.json({
      referralCode:       member.referralCode,
      walletBalance:      member.walletBalance,
      totalReferredUsers: member.totalReferredUsers
    });
  } catch (err) {
    console.error("[Bonus] generate-code error:", err);
    return res.status(500).json({ error: "Code retrieval failed." });
  }
});

module.exports = router;
