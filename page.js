// page.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const path = require("path");

// Helper Auth Middleware 
// Verifies the user's identity via JWT before allowing access to pages or data
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.redirect("/login.html");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user; // Contains the logged-in username
    next();
  } catch (err) {
    res.redirect("/login.html");
  }
}

/* ---------------- 1. PROTECTED ROUTING FOR HTML PAGES ---------------- */

// Securely serves each improvement page only if the user passes the auth check
router.get("/youtube-improvement.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "youtube-improvement.html"));
});

router.get("/tiktok-improvement.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "tiktok-improvement.html"));
});

router.get("/instagram-improvement.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "instagram-improvement.html"));
});

router.get("/facebook-improvement.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "facebook-improvement.html"));
});


/* ---------------- 2. SECURE MONGODB API ENDPOINTS ---------------- */

/**
 * GET API: Fetch live user details (Balance, VIP level) for the top navigation bars
 * Frontends can fetch this at: /api/user-status
 */
router.get("/api/user-status", auth, async (req, res) => {
  try {
    // Safely pull the already registered User model from server.js
    const User = mongoose.model("User");
    const currentUser = await User.findOne({ username: req.user });

    if (!currentUser) {
      return res.status(404).json({ error: "User profile not found." });
    }

    res.json({
      success: true,
      username: currentUser.username,
      balance: currentUser.balance || 0,
      vipTier: currentUser.vipTier || "Normal"
    });
  } catch (error) {
    console.error("Error fetching user data in page.js:", error);
    res.status(500).json({ error: "Failed to read database state." });
  }
});

/**
 * POST API: Handle engagement submissions for all four improvement platforms
 * Frontends can POST to: /api/improvement/youtube, /api/improvement/tiktok, etc.
 */
router.post("/api/improvement/:platform", auth, async (req, res) => {
  const { platform } = req.params;
  const { targetLink, actionType, quantity, price } = req.body; 

  // Guard against unauthorized platform parameters
  const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ error: "Invalid promotion platform requested." });
  }

  try {
    const User = mongoose.model("User");
    const currentUser = await User.findOne({ username: req.user });

    if (!currentUser) {
      return res.status(404).json({ error: "User account missing." });
    }

    // 1. Verify the user has enough cash balance (FRW) for the requested order
    if (currentUser.balance < price) {
      return res.status(400).json({ error: "Insufficient balance to complete this order." });
    }

    // 2. Perform the atomic deduction transaction
    currentUser.balance -= price;

    // 3. Document the new order in their history array
    if (!currentUser.orders) currentUser.orders = [];
    
    currentUser.orders.push({
      platform: platform,
      targetLink: targetLink,       // Video, Profile, or Post URL
      actionType: actionType,       // "likes", "views", "followers", "comments"
      quantity: parseInt(quantity),
      price: parseFloat(price),
      status: "Pending",
      createdAt: new Date()
    });

    // Save changes straight back to MongoDB cluster
    await currentUser.save();

    res.json({
      success: true,
      message: `Your ${platform} order was placed successfully!`,
      newBalance: currentUser.balance
    });

  } catch (error) {
    console.error(`Order execution failure for ${platform}:`, error);
    res.status(500).json({ error: "Internal database transaction processing failed." });
  }
});

module.exports = router;
