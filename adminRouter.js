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

module.exports = router;
