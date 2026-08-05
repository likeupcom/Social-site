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
  try {
    if (!process.env.MONGODB_URI) return;
    await connectToDatabase();
    const hash = await bcrypt.hash("123456", 10);
    await Admin.updateOne({ username: "simeon" }, { password: hash }, { upsert: true });
  } catch (err) {
    console.warn("⚠️ Admin seed skipped/error during startup:", err.message);
  }
}
seedAdmin().catch(() => {});

/* ─── Custom verifyAdmin middleware for checking admin session tokens ─── */
function verifyAdmin(req, res, next) {
  const token = req.cookies.admin_token || 
                (req.headers.authorization && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null) ||
                (req.headers["x-admin-token"]) ||
                req.query.admin_token || 
                req.query.token;

  if (!token) return res.status(401).json({ error: "Admin access token required." });

  try {
    const decoded = jwt.verify(token, ADMIN_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({ error: "Access denied. Admin privileges required." });
    }
    req.adminUser = decoded.username;
    next();
  } catch (err) {
    res.clearCookie("admin_token", { secure: true, sameSite: "none" });
    return res.status(401).json({ error: "Invalid or expired admin session token." });
  }
}

const adminAuth = verifyAdmin;

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

    const Withdrawal = mongoose.models.Withdrawal || mongoose.model("Withdrawal");

    const members = await Member.find({}).sort({ createdAt: -1 }).lean();

    let withdrawals = [];
    if (Withdrawal) {
      const userIds = members.map(m => m.userId);
      withdrawals = await Withdrawal.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean();
    }

    const membersWithWithdrawal = members.map(m => {
      let w = withdrawals.find(x => x.userId === m.userId && x.status === "pending")
           || withdrawals.find(x => x.userId === m.userId);
      return {
        ...m,
        withdrawal: w ? {
          id: w._id.toString(),
          amount: w.amount,
          status: w.status,
          createdAt: w.createdAt
        } : null
      };
    });

    return res.json({ members: membersWithWithdrawal });
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
   PATCH /api/admin/members/:id/withdrawal — approve | reject member withdrawal
================================================================= */
router.patch("/api/admin/members/:id/withdrawal", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const Member = getMember();
    if (!Member) return res.status(500).json({ error: "Member model not loaded." });

    const Withdrawal = mongoose.models.Withdrawal || mongoose.model("Withdrawal");
    if (!Withdrawal) return res.status(500).json({ error: "Withdrawal model not loaded." });

    const { status } = req.body;
    if (!status || !["approved", "rejected"].includes(status.toLowerCase())) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }

    const targetStatus = status.toLowerCase();
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).json({ error: "Member not found." });

    let withdrawal = await Withdrawal.findOne({ userId: member.userId, status: "pending" });
    if (!withdrawal) {
      withdrawal = await Withdrawal.findOne({ userId: member.userId }).sort({ createdAt: -1 });
    }

    if (!withdrawal) {
      return res.status(404).json({ error: "No withdrawal request found for this member." });
    }

    withdrawal.status = targetStatus;
    withdrawal.updatedAt = new Date();
    await withdrawal.save();

    if (targetStatus === "approved") {
      member.walletBalance = 0;
      await member.save();
    }

    return res.json({
      success: true,
      message: `Withdrawal request ${targetStatus} successfully.`,
      member,
      withdrawal: {
        id: withdrawal._id.toString(),
        amount: withdrawal.amount,
        status: withdrawal.status
      }
    });
  } catch (err) {
    console.error("[Admin patch withdrawal]", err);
    return res.status(500).json({ error: "Withdrawal update failed." });
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
   if (newPassword && newPassword.trim().length >= 6) {
  update.password = await bcrypt.hash(newPassword.trim(), 10);
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
  if (!mongoose.models.YTActiveSlot || !mongoose.models.YTWaitingQueue) {
    try { require("./page.js"); } catch (e) {}
  }
  return {
    YTActiveSlot:   mongoose.models.YTActiveSlot,
    YTWaitingQueue: mongoose.models.YTWaitingQueue,
    YTUserProfile:  mongoose.models.YTUserProfile,
    VIPQueue:       mongoose.models.VIPQueue
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
    const { YTActiveSlot, YTWaitingQueue, YTUserProfile, VIPQueue } = getYTModels();
    if (!YTActiveSlot) return res.status(500).json({ error: "YT models not loaded yet." });

    const slot = await YTActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });

    const userId = slot.userId;

    // Reset profile for removed user so they are freed from board lock
    if (YTUserProfile && userId) {
      await YTUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    // Clean up appealedBy references in waiting list
    if (YTWaitingQueue && userId) {
      await YTWaitingQueue.updateMany(
        { appealedBy: userId },
        { $pull: { appealedBy: userId } }
      );
    }

    // Auto VIP Queue Promotion: If a VIP slot (sequencePosition < 4 or isVip) was freed
    if ((slot.isVip || slot.sequencePosition < 4) && VIPQueue) {
      const nextVip = await VIPQueue.findOne({ platform: "youtube" }).sort({ createdAt: 1 });
      if (nextVip) {
        let freePos = slot.sequencePosition;
        if (freePos < 0 || freePos > 3) freePos = 0;

        await YTActiveSlot.create({
          userId: nextVip.userId,
          username: nextVip.username,
          youtubeChannel: nextVip.targetLink,
          youtubeVideo: nextVip.targetLink,
          isVip: true,
          sequencePosition: freePos,
          packageId: nextVip.packageId,
          engagementTarget: nextVip.engagementTarget,
          views: 0, subs: 0, likes: 0, comments: 0
        });

        await VIPQueue.deleteOne({ _id: nextVip._id });
      }
    }

    return res.json({ success: true, message: `Removed ${slot.username} from YouTube slot.` });
  } catch (err) {
    console.error("[Admin YT remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/youtube/queue/:queueId ── */
router.delete("/api/admin/youtube/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { YTWaitingQueue, YTUserProfile } = getYTModels();
    if (!YTWaitingQueue) return res.status(500).json({ error: "YT models not loaded yet." });

    const entry = await YTWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });

    const userId = entry.userId;
    if (YTUserProfile && userId) {
      await YTUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    return res.json({ success: true, message: `Removed ${entry.username} from YouTube queue.` });
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
  if (!mongoose.models.TKActiveSlot || !mongoose.models.TKWaitingQueue) {
    try { require("./page1.js"); } catch (e) {}
  }
  return {
    TKActiveSlot:   mongoose.models.TKActiveSlot,
    TKWaitingQueue: mongoose.models.TKWaitingQueue,
    TKUserProfile:  mongoose.models.TKUserProfile,
    TKVIPQueue:     mongoose.models.TKVIPQueue
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
    const { TKActiveSlot, TKWaitingQueue, TKUserProfile, TKVIPQueue } = getTKModels();
    if (!TKActiveSlot) return res.status(500).json({ error: "TK models not loaded yet." });

    const slot = await TKActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });

    const userId = slot.userId;

    if (TKUserProfile && userId) {
      await TKUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    if (TKWaitingQueue && userId) {
      await TKWaitingQueue.updateMany(
        { appealedBy: userId },
        { $pull: { appealedBy: userId } }
      );
    }

    if ((slot.isVip || slot.sequencePosition < 4) && TKVIPQueue) {
      const nextVip = await TKVIPQueue.findOne().sort({ createdAt: 1 });
      if (nextVip) {
        let freePos = slot.sequencePosition;
        if (freePos < 0 || freePos > 3) freePos = 0;

        await TKActiveSlot.create({
          userId: nextVip.userId,
          username: nextVip.username,
          TiktokChannel: nextVip.targetLink,
          TiktokVideo: nextVip.targetLink,
          isVip: true,
          sequencePosition: freePos,
          packageId: nextVip.packageId,
          engagementTarget: nextVip.engagementTarget,
          views: 0, subs: 0, likes: 0, comments: 0
        });

        await TKVIPQueue.deleteOne({ _id: nextVip._id });
      }
    }

    return res.json({ success: true, message: `Removed ${slot.username} from TikTok slot.` });
  } catch (err) {
    console.error("[Admin TK remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/tiktok/queue/:queueId ── */
router.delete("/api/admin/tiktok/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { TKWaitingQueue, TKUserProfile } = getTKModels();
    if (!TKWaitingQueue) return res.status(500).json({ error: "TK models not loaded yet." });

    const entry = await TKWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });

    const userId = entry.userId;
    if (TKUserProfile && userId) {
      await TKUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    return res.json({ success: true, message: `Removed ${entry.username} from TikTok queue.` });
  } catch (err) {
    console.error("[Admin TK remove queue]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ================================================================
   Instagram Board Admin Routes
   Models IGActiveSlot / IGWaitingQueue registered by page2.js.
================================================================= */

function getIGModels() {
  if (!mongoose.models.IGActiveSlot || !mongoose.models.IGWaitingQueue) {
    try { require("./page2.js"); } catch (e) {}
  }
  return {
    IGActiveSlot:   mongoose.models.IGActiveSlot,
    IGWaitingQueue: mongoose.models.IGWaitingQueue,
    IGUserProfile:  mongoose.models.IGUserProfile,
    IGVIPQueue:     mongoose.models.IGVIPQueue
  };
}

/* ── GET /api/admin/instagram/board ── */
router.get("/api/admin/instagram/board", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.models.User;
    const { IGActiveSlot, IGWaitingQueue } = getIGModels();
    if (!IGActiveSlot) return res.status(500).json({ error: "IG models not loaded yet — restart the server." });

    const users = await User.find({})
      .select("_id username instagram_link").lean();

    const activeSlots = await IGActiveSlot.find().sort({ sequencePosition: 1 }).lean();
    const waitingList = await IGWaitingQueue.find().sort({ timestamp: 1 }).lean();

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
    console.error("[Admin IG board]", err);
    return res.status(500).json({ error: "Failed to load Instagram board." });
  }
});

/* ── POST /api/admin/instagram/assign ── */
router.post("/api/admin/instagram/assign", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { userId, section } = req.body;
    if (!userId || !section) return res.status(400).json({ error: "userId and section are required." });
    if (!["vip", "standard", "queue"].includes(section))
      return res.status(400).json({ error: "section must be vip, standard, or queue." });

    const User = mongoose.models.User;
    const { IGActiveSlot, IGWaitingQueue } = getIGModels();

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const channelLink = req.body.instagramChannel || user.instagram_link || "";
    const videoLink   = req.body.instagramVideo   || channelLink;

    if (!channelLink)
      return res.status(400).json({ error: `${user.username} has no Instagram account linked — please enter the link in the form.` });

    const uid = user._id.toString();

    const alreadyActive = await IGActiveSlot.findOne({ userId: uid });
    if (alreadyActive)
      return res.status(409).json({ error: `${user.username} is already in an active slot (position ${alreadyActive.sequencePosition}).` });
    const alreadyQueued = await IGWaitingQueue.findOne({ userId: uid });
    if (alreadyQueued)
      return res.status(409).json({ error: `${user.username} is already in the waiting list.` });

    if (section === "queue") {
      await IGWaitingQueue.create({
        userId: uid,
        username:         user.username,
        instagramChannel: channelLink,
        instagramVideo:   videoLink,
        appealCount: 0,
        appealedBy:  []
      });
      return res.json({ success: true, message: `${user.username} added to the Waiting List.` });
    }

    const range = section === "vip" ? [0,1,2,3] : [4,5,6,7,8,9,10,11,12,13];
    let freePos = -1;
    for (const pos of range) {
      const taken = await IGActiveSlot.findOne({ sequencePosition: pos });
      if (!taken) { freePos = pos; break; }
    }
    if (freePos === -1) {
      const label = section === "vip" ? "VIP (all 4 slots are full)" : "Standard (all 10 slots are full)";
      return res.status(409).json({ error: `No free slot in ${label}. Remove a user first or assign to Queue.` });
    }

    await IGActiveSlot.create({
      userId: uid,
      username:         user.username,
      instagramChannel: channelLink,
      instagramVideo:   videoLink,
      isVip:  section === "vip",
      sequencePosition: freePos,
      views: 0, followers: 0, likes: 0, comments: 0
    });

    const label = section === "vip" ? `VIP slot #${freePos}` : `Standard slot #${freePos}`;
    return res.json({ success: true, message: `${user.username} assigned to ${label}.` });
  } catch (err) {
    console.error("[Admin IG assign]", err);
    return res.status(500).json({ error: "Assignment failed." });
  }
});

/* ── DELETE /api/admin/instagram/slot/:slotId ── */
router.delete("/api/admin/instagram/slot/:slotId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { IGActiveSlot, IGWaitingQueue, IGUserProfile, IGVIPQueue } = getIGModels();
    if (!IGActiveSlot) return res.status(500).json({ error: "IG models not loaded yet." });

    const slot = await IGActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });

    const userId = slot.userId;

    if (IGUserProfile && userId) {
      await IGUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    if (IGWaitingQueue && userId) {
      await IGWaitingQueue.updateMany(
        { appealedBy: userId },
        { $pull: { appealedBy: userId } }
      );
    }

    if ((slot.isVip || slot.sequencePosition < 4) && IGVIPQueue) {
      const nextVip = await IGVIPQueue.findOne().sort({ createdAt: 1 });
      if (nextVip) {
        let freePos = slot.sequencePosition;
        if (freePos < 0 || freePos > 3) freePos = 0;

        await IGActiveSlot.create({
          userId: nextVip.userId,
          username: nextVip.username,
          instagramChannel: nextVip.targetLink,
          instagramVideo: nextVip.targetLink,
          isVip: true,
          sequencePosition: freePos,
          packageId: nextVip.packageId,
          engagementTarget: nextVip.engagementTarget,
          views: 0, followers: 0, likes: 0, comments: 0
        });

        await IGVIPQueue.deleteOne({ _id: nextVip._id });
      }
    }

    return res.json({ success: true, message: `Removed ${slot.username} from Instagram slot.` });
  } catch (err) {
    console.error("[Admin IG remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/instagram/queue/:queueId ── */
router.delete("/api/admin/instagram/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { IGWaitingQueue, IGUserProfile } = getIGModels();
    if (!IGWaitingQueue) return res.status(500).json({ error: "IG models not loaded yet." });

    const entry = await IGWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });

    const userId = entry.userId;
    if (IGUserProfile && userId) {
      await IGUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    return res.json({ success: true, message: `Removed ${entry.username} from Instagram queue.` });
  } catch (err) {
    console.error("[Admin IG remove queue]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ================================================================
   Facebook Board Admin Routes
   Models FBActiveSlot / FBWaitingQueue registered by page3.js.
================================================================= */

function getFBModels() {
  if (!mongoose.models.FBActiveSlot || !mongoose.models.FBWaitingQueue) {
    try { require("./page3.js"); } catch (e) {}
  }
  return {
    FBActiveSlot:   mongoose.models.FBActiveSlot,
    FBWaitingQueue: mongoose.models.FBWaitingQueue,
    FBUserProfile:  mongoose.models.FBUserProfile,
    FBVIPQueue:     mongoose.models.FBVIPQueue
  };
}

/* ── GET /api/admin/facebook/board ── */
router.get("/api/admin/facebook/board", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.models.User;
    const { FBActiveSlot, FBWaitingQueue } = getFBModels();
    if (!FBActiveSlot) return res.status(500).json({ error: "FB models not loaded yet — restart the server." });

    const users = await User.find({})
      .select("_id username facebook_link").lean();

    const activeSlots = await FBActiveSlot.find().sort({ sequencePosition: 1 }).lean();
    const waitingList = await FBWaitingQueue.find().sort({ timestamp: 1 }).lean();

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
    console.error("[Admin FB board]", err);
    return res.status(500).json({ error: "Failed to load Facebook board." });
  }
});

/* ── POST /api/admin/facebook/assign ── */
router.post("/api/admin/facebook/assign", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { userId, section } = req.body;
    if (!userId || !section) return res.status(400).json({ error: "userId and section are required." });
    if (!["vip", "standard", "queue"].includes(section))
      return res.status(400).json({ error: "section must be vip, standard, or queue." });

    const User = mongoose.models.User;
    const { FBActiveSlot, FBWaitingQueue } = getFBModels();

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const channelLink = req.body.facebookChannel || user.facebook_link || "";
    const videoLink   = req.body.facebookVideo   || channelLink;

    if (!channelLink)
      return res.status(400).json({ error: `${user.username} has no Facebook account linked — please enter the link in the form.` });

    const uid = user._id.toString();

    const alreadyActive = await FBActiveSlot.findOne({ userId: uid });
    if (alreadyActive)
      return res.status(409).json({ error: `${user.username} is already in an active slot (position ${alreadyActive.sequencePosition}).` });
    const alreadyQueued = await FBWaitingQueue.findOne({ userId: uid });
    if (alreadyQueued)
      return res.status(409).json({ error: `${user.username} is already in the waiting list.` });

    if (section === "queue") {
      await FBWaitingQueue.create({
        userId: uid,
        username:        user.username,
        facebookChannel: channelLink,
        facebookVideo:   videoLink,
        appealCount: 0,
        appealedBy:  []
      });
      return res.json({ success: true, message: `${user.username} added to the Waiting List.` });
    }

    const range = section === "vip" ? [0,1,2,3] : [4,5,6,7,8,9,10,11,12,13];
    let freePos = -1;
    for (const pos of range) {
      const taken = await FBActiveSlot.findOne({ sequencePosition: pos });
      if (!taken) { freePos = pos; break; }
    }
    if (freePos === -1) {
      const label = section === "vip" ? "VIP (all 4 slots are full)" : "Standard (all 10 slots are full)";
      return res.status(409).json({ error: `No free slot in ${label}. Remove a user first or assign to Queue.` });
    }

    await FBActiveSlot.create({
      userId: uid,
      username:        user.username,
      facebookChannel: channelLink,
      facebookVideo:   videoLink,
      isVip:  section === "vip",
      sequencePosition: freePos,
      views: 0, followers: 0, likes: 0, comments: 0
    });

    const label = section === "vip" ? `VIP slot #${freePos}` : `Standard slot #${freePos}`;
    return res.json({ success: true, message: `${user.username} assigned to ${label}.` });
  } catch (err) {
    console.error("[Admin FB assign]", err);
    return res.status(500).json({ error: "Assignment failed." });
  }
});

/* ── DELETE /api/admin/facebook/slot/:slotId ── */
router.delete("/api/admin/facebook/slot/:slotId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { FBActiveSlot, FBWaitingQueue, FBUserProfile, FBVIPQueue } = getFBModels();
    if (!FBActiveSlot) return res.status(500).json({ error: "FB models not loaded yet." });

    const slot = await FBActiveSlot.findByIdAndDelete(req.params.slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found." });

    const userId = slot.userId;

    if (FBUserProfile && userId) {
      await FBUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    if (FBWaitingQueue && userId) {
      await FBWaitingQueue.updateMany(
        { appealedBy: userId },
        { $pull: { appealedBy: userId } }
      );
    }

    if ((slot.isVip || slot.sequencePosition < 4) && FBVIPQueue) {
      const nextVip = await FBVIPQueue.findOne().sort({ createdAt: 1 });
      if (nextVip) {
        let freePos = slot.sequencePosition;
        if (freePos < 0 || freePos > 3) freePos = 0;

        await FBActiveSlot.create({
          userId: nextVip.userId,
          username: nextVip.username,
          facebookChannel: nextVip.targetLink,
          facebookVideo: nextVip.targetLink,
          isVip: true,
          sequencePosition: freePos,
          packageId: nextVip.packageId,
          engagementTarget: nextVip.engagementTarget,
          views: 0, followers: 0, likes: 0, comments: 0
        });

        await FBVIPQueue.deleteOne({ _id: nextVip._id });
      }
    }

    return res.json({ success: true, message: `Removed ${slot.username} from Facebook slot.` });
  } catch (err) {
    console.error("[Admin FB remove slot]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ── DELETE /api/admin/facebook/queue/:queueId ── */
router.delete("/api/admin/facebook/queue/:queueId", adminAuth, async (req, res) => {
  try {
    await connectToDatabase();
    const { FBWaitingQueue, FBUserProfile } = getFBModels();
    if (!FBWaitingQueue) return res.status(500).json({ error: "FB models not loaded yet." });

    const entry = await FBWaitingQueue.findByIdAndDelete(req.params.queueId);
    if (!entry) return res.status(404).json({ error: "Queue entry not found." });

    const userId = entry.userId;
    if (FBUserProfile && userId) {
      await FBUserProfile.findOneAndUpdate(
        { userId },
        { $set: { acceptedConditions: false, visitedChannels: [], activeSequenceIndex: 0 } },
        { upsert: false }
      );
    }

    return res.json({ success: true, message: `Removed ${entry.username} from Facebook queue.` });
  } catch (err) {
    console.error("[Admin FB remove queue]", err);
    return res.status(500).json({ error: "Remove failed." });
  }
});

/* ================================================================
   Deposit Admin Routes
   Models & Endpoints for managing user deposit requests
================================================================= */

function getDepositModel() {
  return mongoose.models.Deposit;
}

/* ── GET /api/admin/deposits/pending — list all pending deposits for admins ── */
router.get("/api/admin/deposits/pending", verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();
    const Deposit = getDepositModel();
    if (!Deposit) return res.status(500).json({ error: "Deposit model not loaded." });

    const deposits = await Deposit.find({ status: { $in: ["pending", "PENDING"] } })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = deposits.map(d => ({
      id: d._id.toString(),
      _id: d._id.toString(),
      userId: d.userId,
      username: d.username || "",
      sender_name: d.sender_name || d.fullName || "",
      phone_number: d.phone_number || d.telephone || "",
      amount: d.amount,
      proof_image: d.proof_image || d.screenshotData || "",
      screenshotMimeType: d.screenshotMimeType || "image/png",
      status: d.status,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt || d.createdAt
    }));

    return res.json({ deposits: formatted });
  } catch (err) {
    console.error("[Admin GET pending deposits]", err);
    return res.status(500).json({ error: "Failed to fetch pending deposits." });
  }
});

/* ── GET /api/admin/deposits — list all deposits (optional ?status= query filter) ── */
router.get("/api/admin/deposits", verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();
    const Deposit = getDepositModel();
    if (!Deposit) return res.status(500).json({ error: "Deposit model not loaded." });

    const filter = {};
    if (req.query.status) {
      filter.status = new RegExp("^" + req.query.status.trim() + "$", "i");
    }

    const deposits = await Deposit.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const formatted = deposits.map(d => ({
      id: d._id.toString(),
      _id: d._id.toString(),
      userId: d.userId,
      username: d.username || "",
      sender_name: d.sender_name || d.fullName || "",
      phone_number: d.phone_number || d.telephone || "",
      amount: d.amount,
      proof_image: d.proof_image || d.screenshotData || "",
      screenshotMimeType: d.screenshotMimeType || "image/png",
      status: d.status,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt || d.createdAt
    }));

    return res.json({ deposits: formatted });
  } catch (err) {
    console.error("[Admin GET deposits]", err);
    return res.status(500).json({ error: "Failed to fetch deposits." });
  }
});

/* ── PATCH /api/admin/deposits/:id — approve or reject a deposit request ── */
router.patch("/api/admin/deposits/:id", verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();
    const Deposit = getDepositModel();
    const User = mongoose.models.User;
    if (!Deposit) return res.status(500).json({ error: "Deposit model not loaded." });

    const { status } = req.body;
    if (!status || !["approved", "rejected", "APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }

    const targetStatus = status.toLowerCase(); // 'approved' or 'rejected'
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) return res.status(404).json({ error: "Deposit request not found." });

    let walletUpdated = false;
    let newBalance = null;

    if (targetStatus === "approved" && deposit.status.toLowerCase() !== "approved") {
      // Find matching user in User model to credit VIP wallet balance
      let user = null;
      if (deposit.userId && mongoose.Types.ObjectId.isValid(deposit.userId)) {
        user = await User.findById(deposit.userId);
      }
      if (!user && deposit.username) {
        user = await User.findOne({ username: deposit.username });
      }
      if (!user && (deposit.sender_name || deposit.fullName)) {
        const nameToMatch = deposit.sender_name || deposit.fullName;
        user = await User.findOne({ username: nameToMatch });
      }

      if (user) {
        const updatedUser = await User.findByIdAndUpdate(
          user._id,
          { $inc: { walletBalance: deposit.amount } },
          { new: true }
        );
        walletUpdated = true;
        newBalance = updatedUser.walletBalance;
      } else {
        console.warn(`[Admin approve deposit] User not found for deposit ID ${deposit._id}, userId: ${deposit.userId}`);
      }
    }

    // Update status while maintaining all user details (sender_name, phone_number, amount, proof_image)
    deposit.status = targetStatus;
    deposit.updatedAt = new Date();
    await deposit.save();

    const responseDeposit = {
      id: deposit._id.toString(),
      _id: deposit._id.toString(),
      userId: deposit.userId,
      username: deposit.username || "",
      sender_name: deposit.sender_name || deposit.fullName || "",
      phone_number: deposit.phone_number || deposit.telephone || "",
      amount: deposit.amount,
      proof_image: deposit.proof_image || deposit.screenshotData || "",
      screenshotMimeType: deposit.screenshotMimeType || "image/png",
      status: deposit.status,
      createdAt: deposit.createdAt,
      updatedAt: deposit.updatedAt
    };

    return res.json({
      success: true,
      message: `Deposit request status updated to ${targetStatus}.${walletUpdated ? ` User main wallet balance updated to ${newBalance} FRW.` : ''}`,
      deposit: responseDeposit,
      walletUpdated,
      newBalance
    });
  } catch (err) {
    console.error("[Admin PATCH deposit status]", err);
    return res.status(500).json({ error: "Deposit status update failed." });
  }
});

module.exports = router;
