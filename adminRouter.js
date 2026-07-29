// adminRouter.js — Secure Admin Dashboard Routes

const express = require("express");
const router  = express.Router();
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
const { connectToDatabase } = require("./lib/db");

const JWT_SECRET   = process.env.JWT_SECRET || "ns-platform-super-secret-key";
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET + "-admin";

/* ─── Admin Credentials Model ─── */
const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }  // bcrypt hash
});
const Admin = mongoose.models.Admin || mongoose.model("Admin", AdminSchema);

/* ─── Member model reference (defined in bonusRouter.js, cached by mongoose) ─── */
function getMember() {
  return mongoose.models.Member;
}

/* ─── Seed default admin on first run ─── */
async function seedAdmin() {
  await connectToDatabase();
  const count = await Admin.countDocuments();
  if (count === 0) {
    const hash = await bcrypt.hash("123456", 10);
    await Admin.create({ username: "simeo", password: hash });
    console.log("✅ Default admin account created (simeo / 123456)");
  }
}
seedAdmin().catch(console.error);

/* ─── Admin auth middleware ─── */
function adminAuth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: "Admin not authenticated." });
  try {
    const decoded = jwt.verify(token, ADMIN_SECRET);
    if (!decoded.isAdmin) throw new Error("Not an admin token");
    req.adminUser = decoded.username;
    next();
  } catch {
    res.clearCookie("admin_token", { secure: true, sameSite: "none" });
    return res.status(401).json({ error: "Admin session expired." });
  }
}

/* ================================================================
   POST /api/admin/login
================================================================= */
router.post("/api/admin/login", async (req, res) => {
  try {
    await connectToDatabase();
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required." });

    const admin = await Admin.findOne({ username: username.trim() });
    if (!admin) return res.status(401).json({ error: "Invalid credentials." });

    const match = await bcrypt.compare(password.trim(), admin.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials." });

    const token = jwt.sign({ isAdmin: true, username: admin.username }, ADMIN_SECRET, { expiresIn: "8h" });
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 8 * 60 * 60 * 1000
    });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin login]", err);
    return res.status(500).json({ error: "Login failed." });
  }
});

/* ================================================================
   POST /api/admin/logout
================================================================= */
router.post("/api/admin/logout", (req, res) => {
  res.clearCookie("admin_token", { secure: true, sameSite: "none" });
  return res.json({ success: true });
});

/* ================================================================
   GET /api/admin/check  — ping to see if session is valid
================================================================= */
router.get("/api/admin/check", adminAuth, (req, res) => {
  res.json({ ok: true, username: req.adminUser });
});

/* ================================================================
   GET /api/admin/members  — list all bonus members
================================================================= */
router.get("/api/admin/members", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const Member = getMember();
    if (!Member) return res.status(500).json({ error: "Member model not loaded." });

    const members = await Member.find({}).sort({ createdAt: -1 }).lean();
    return res.json({ members });
  } catch (err) {
    console.error("[Admin members]", err);
    return res.status(500).json({ error: "Failed to fetch members." });
  }
});

/* ================================================================
   PATCH /api/admin/members/:id  — edit name, phone, balance
================================================================= */
router.patch("/api/admin/members/:id", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const Member = getMember();
    const { fullName, phoneNumber, walletBalance } = req.body;

    const update = {};
    if (fullName     !== undefined) update.fullName     = fullName.trim();
    if (phoneNumber  !== undefined) {
      if (!/^\d{10}$/.test(phoneNumber.trim()))
        return res.status(400).json({ error: "Phone must be exactly 10 digits." });
      // ensure no duplicate phone
      const clash = await Member.findOne({ phoneNumber: phoneNumber.trim(), _id: { $ne: req.params.id } });
      if (clash) return res.status(409).json({ error: "Phone number already used by another member." });
      update.phoneNumber = phoneNumber.trim();
    }
    if (walletBalance !== undefined) {
      const val = parseFloat(walletBalance);
      if (isNaN(val) || val < 0) return res.status(400).json({ error: "Balance must be a non-negative number." });
      update.walletBalance = val;
    }

    const member = await Member.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!member) return res.status(404).json({ error: "Member not found." });
    return res.json({ success: true, member });
  } catch (err) {
    console.error("[Admin patch member]", err);
    return res.status(500).json({ error: "Update failed." });
  }
});

/* ================================================================
   PATCH /api/admin/members/:id/status  — ban | activate
================================================================= */
router.patch("/api/admin/members/:id/status", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const Member = getMember();
    const { status } = req.body;
    if (!["active", "banned"].includes(status))
      return res.status(400).json({ error: "Status must be 'active' or 'banned'." });

    const member = await Member.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!member) return res.status(404).json({ error: "Member not found." });
    return res.json({ success: true, member });
  } catch (err) {
    console.error("[Admin status]", err);
    return res.status(500).json({ error: "Status update failed." });
  }
});

/* ================================================================
   DELETE /api/admin/members/:id  — permanently delete member
================================================================= */
router.delete("/api/admin/members/:id", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const Member = getMember();
    const member = await Member.findByIdAndDelete(req.params.id);
    if (!member) return res.status(404).json({ error: "Member not found." });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin delete member]", err);
    return res.status(500).json({ error: "Delete failed." });
  }
});

/* ================================================================
   POST /api/admin/change-credentials  — update admin username/password
================================================================= */
router.post("/api/admin/change-credentials", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { newUsername, newPassword, currentPassword } = req.body;

    const admin = await Admin.findOne({ username: req.adminUser });
    if (!admin) return res.status(404).json({ error: "Admin account not found." });

    // Verify current password before allowing change
    const match = await bcrypt.compare(currentPassword, admin.password);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    const update = {};
    if (newUsername && newUsername.trim()) update.username = newUsername.trim();
    if (newPassword && newPassword.length >= 6) {
      update.password = await bcrypt.hash(newPassword, 10);
    } else if (newPassword) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    if (Object.keys(update).length === 0)
      return res.status(400).json({ error: "Nothing to update." });

    // Check username uniqueness
    if (update.username) {
      const clash = await Admin.findOne({ username: update.username });
      if (clash && clash._id.toString() !== admin._id.toString())
        return res.status(409).json({ error: "Username already taken." });
    }

    await Admin.findByIdAndUpdate(admin._id, update);

    // Issue new token with potentially updated username
    const newAdminUsername = update.username || admin.username;
    const token = jwt.sign({ isAdmin: true, username: newAdminUsername }, ADMIN_SECRET, { expiresIn: "8h" });
    res.cookie("admin_token", token, { httpOnly: true, secure: true, sameSite: "none", maxAge: 8 * 60 * 60 * 1000 });

    return res.json({ success: true, username: newAdminUsername });
  } catch (err) {
    console.error("[Admin change-credentials]", err);
    return res.status(500).json({ error: "Credential update failed." });
  }
});

/* ================================================================
   YouTube Board Admin Routes
   Models YTActiveSlot / YTWaitingQueue are registered by page.js
   at startup, so they are available by the time any request arrives.
================================================================= */

function getYTModels() {
  return {
    YTActiveSlot:   mongoose.models.YTActiveSlot,
    YTWaitingQueue: mongoose.models.YTWaitingQueue
  };
}

/* ── GET /api/admin/youtube/board ── */
router.get("/api/admin/youtube/board", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.models.User;
    const { YTActiveSlot, YTWaitingQueue } = getYTModels();
    if (!YTActiveSlot) return res.status(500).json({ error: "YT models not loaded yet — restart the server." });

    // All users who have linked a YouTube channel
    const users = await User.find({})
      .select("_id username youtubeChannel").lean();

    const activeSlots  = await YTActiveSlot.find().sort({ sequencePosition: 1 }).lean();
    const waitingList  = await YTWaitingQueue.find().sort({ timestamp: 1 }).lean();

    // Build structured slot arrays
    const vipSlots = [];
    for (let i = 0; i < 4; i++) {
      const slot = activeSlots.find(s => s.sequencePosition === i);
      vipSlots.push(slot ? { ...slot, position: i, occupied: true } : { position: i, occupied: false });
    }
    const standardSlots = [];
    for (let i = 4; i < 14; i++) {
      const slot = activeSlots.find(s => s.sequencePosition === i);
      standardSlots.push(slot ? { ...slot, position: i, occupied: true } : { position: i, occupied: false });
    }

    return res.json({ users, vipSlots, standardSlots, waitingList });
  } catch (err) {
    console.error("[Admin YT board]", err);
    return res.status(500).json({ error: "Failed to load YouTube board." });
  }
});

/* ── POST /api/admin/youtube/assign ── */
router.post("/api/admin/youtube/assign", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { userId, section } = req.body; // section: 'vip' | 'standard' | 'queue'
    if (!userId || !section) return res.status(400).json({ error: "userId and section are required." });
    if (!["vip", "standard", "queue"].includes(section))
      return res.status(400).json({ error: "section must be vip, standard, or queue." });

    const User = mongoose.models.User;
    const { YTActiveSlot, YTWaitingQueue } = getYTModels();

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    // Admin-supplied links take priority; fall back to user's stored profile links
    const channelLink = req.body.youtubeChannel || user.youtubeChannel || "";
    const videoLink   = req.body.youtubeVideo   || channelLink;

    if (!channelLink)
      return res.status(400).json({ error: `${user.username} has no YouTube channel — please enter the channel link in the form.` });

    const uid = user._id.toString();

    // Prevent duplicate assignments
    const alreadyActive = await YTActiveSlot.findOne({ userId: uid });
    if (alreadyActive)
      return res.status(409).json({ error: `${user.username} is already in an active slot (position ${alreadyActive.sequencePosition}).` });
    const alreadyQueued = await YTWaitingQueue.findOne({ userId: uid });
    if (alreadyQueued)
      return res.status(409).json({ error: `${user.username} is already in the waiting list.` });

    if (section === "queue") {
      await YTWaitingQueue.create({
        userId: uid,
        username: user.username,
        youtubeChannel: channelLink,
        youtubeVideo:   videoLink,
        appealCount: 0,
        appealedBy:  []
      });
      return res.json({ success: true, message: `${user.username} added to the Waiting List.` });
    }

    // Find first free position in the requested section
    const range = section === "vip" ? [0,1,2,3] : [4,5,6,7,8,9,10,11,12,13];
    let freePos = -1;
    for (const pos of range) {
      const taken = await YTActiveSlot.findOne({ sequencePosition: pos });
      if (!taken) { freePos = pos; break; }
    }
    if (freePos === -1) {
      const label = section === "vip" ? "VIP (all 4 slots are full)" : "Standard (all 10 slots are full)";
      return res.status(409).json({ error: `No free slot in ${label}. Remove a user first or assign to Queue.` });
    }

    await YTActiveSlot.create({
      userId: uid,
      username: user.username,
      youtubeChannel: channelLink,
      youtubeVideo:   videoLink,
      isVip:  section === "vip",
      sequencePosition: freePos,
      views: 0, subs: 0, likes: 0, comments: 0
    });

    const label = section === "vip" ? `VIP slot #${freePos}` : `Standard slot #${freePos}`;
    return res.json({ success: true, message: `${user.username} assigned to ${label}.` });
  } catch (err) {
    console.error("[Admin YT assign]", err);
    return res.status(500).json({ error: "Assignment failed." });
  }
});

/* ── DELETE /api/admin/youtube/slot/:slotId ── */
router.delete("/api/admin/youtube/slot/:slotId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { YTActiveSlot } = getYTModels();
    const slot = await YTActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin YT remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/youtube/queue/:queueId ── */
router.delete("/api/admin/youtube/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { YTWaitingQueue } = getYTModels();
    const entry = await YTWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin YT remove queue]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ================================================================
   TikTok Board Admin Routes
   Models TKActiveSlot / TKWaitingQueue registered by page1.js at startup.
================================================================= */

function getTKModels() {
  return {
    TKActiveSlot:   mongoose.models.TKActiveSlot,
    TKWaitingQueue: mongoose.models.TKWaitingQueue
  };
}

/* ── GET /api/admin/tiktok/board ── */
router.get("/api/admin/tiktok/board", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.models.User;
    const { TKActiveSlot, TKWaitingQueue } = getTKModels();
    if (!TKActiveSlot) return res.status(500).json({ error: "TK models not loaded yet — restart the server." });

    // All registered users
    const users = await User.find({})
      .select("_id username tiktok_link").lean();

    const activeSlots = await TKActiveSlot.find().sort({ sequencePosition: 1 }).lean();
    const waitingList = await TKWaitingQueue.find().sort({ timestamp: 1 }).lean();

    const vipSlots = [];
    for (let i = 0; i < 4; i++) {
      const slot = activeSlots.find(s => s.sequencePosition === i);
      vipSlots.push(slot ? { ...slot, position: i, occupied: true } : { position: i, occupied: false });
    }
    const standardSlots = [];
    for (let i = 4; i < 14; i++) {
      const slot = activeSlots.find(s => s.sequencePosition === i);
      standardSlots.push(slot ? { ...slot, position: i, occupied: true } : { position: i, occupied: false });
    }

    return res.json({ users, vipSlots, standardSlots, waitingList });
  } catch (err) {
    console.error("[Admin TK board]", err);
    return res.status(500).json({ error: "Failed to load TikTok board." });
  }
});

/* ── POST /api/admin/tiktok/assign ── */
router.post("/api/admin/tiktok/assign", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { userId, section } = req.body;
    if (!userId || !section) return res.status(400).json({ error: "userId and section are required." });
    if (!["vip", "standard", "queue"].includes(section))
      return res.status(400).json({ error: "section must be vip, standard, or queue." });

    const User = mongoose.models.User;
    const { TKActiveSlot, TKWaitingQueue } = getTKModels();

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (!user.tiktok_link)
      return res.status(400).json({ error: `${user.username} has no TikTok account linked on their profile.` });

    const uid = user._id.toString();

    const alreadyActive = await TKActiveSlot.findOne({ userId: uid });
    if (alreadyActive)
      return res.status(409).json({ error: `${user.username} is already in an active slot (position ${alreadyActive.sequencePosition}).` });
    const alreadyQueued = await TKWaitingQueue.findOne({ userId: uid });
    if (alreadyQueued)
      return res.status(409).json({ error: `${user.username} is already in the waiting list.` });

    if (section === "queue") {
      await TKWaitingQueue.create({
        userId: uid,
        username:      user.username,
        TiktokChannel: user.tiktok_link,
        TiktokVideo:   user.tiktok_link,
        appealCount: 0,
        appealedBy:  []
      });
      return res.json({ success: true, message: `${user.username} added to the Waiting List.` });
    }

    const range = section === "vip" ? [0,1,2,3] : [4,5,6,7,8,9,10,11,12,13];
    let freePos = -1;
    for (const pos of range) {
      const taken = await TKActiveSlot.findOne({ sequencePosition: pos });
      if (!taken) { freePos = pos; break; }
    }
    if (freePos === -1) {
      const label = section === "vip" ? "VIP (all 4 slots are full)" : "Standard (all 10 slots are full)";
      return res.status(409).json({ error: `No free slot in ${label}. Remove a user first or assign to Queue.` });
    }

    await TKActiveSlot.create({
      userId: uid,
      username:      user.username,
      TiktokChannel: user.tiktok_link,
      TiktokVideo:   user.tiktok_link,
      isVip:  section === "vip",
      sequencePosition: freePos,
      views: 0, subs: 0, likes: 0, comments: 0
    });

    const label = section === "vip" ? `VIP slot #${freePos}` : `Standard slot #${freePos}`;
    return res.json({ success: true, message: `${user.username} assigned to ${label}.` });
  } catch (err) {
    console.error("[Admin TK assign]", err);
    return res.status(500).json({ error: "Assignment failed." });
  }
});

/* ── DELETE /api/admin/tiktok/slot/:slotId ── */
router.delete("/api/admin/tiktok/slot/:slotId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { TKActiveSlot } = getTKModels();
    const slot = await TKActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin TK remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/tiktok/queue/:queueId ── */
router.delete("/api/admin/tiktok/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { TKWaitingQueue } = getTKModels();
    const entry = await TKWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin TK remove queue]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

module.exports = router;
