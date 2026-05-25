// page.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

// Helper Auth Middleware
// It verifies the user via cookies or query tokens, and extracts the user info safely
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token || (req.headers.authorization && req.headers.authorization.split(" ")[1]);
  if (!token) return res.status(401).json({ error: "Unauthorized access. Missing token." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user; // Typically contains username, id, etc.
    next();
  } catch (err) {
    res.status(401).json({ error: "Session expired or invalid token." });
  }
}

/* ---------------- MONGOOSE SCHEMAS & MODELS SETUPS ---------------- */

// Safely compile or retrieve Mongoose models to prevent "OverwriteModelError"
let YouTubeState;
try {
  YouTubeState = mongoose.model("YouTubeState");
} catch (e) {
  const YouTubeStateSchema = new mongoose.Schema({
    systemPhase: { type: String, default: "REGULAR_PERIOD" },
    sequenceIndex: { type: Number, default: 0 },
    globalMetrics: {
      totalViews: { type: Number, default: 0 },
      totalSubs: { type: Number, default: 0 },
      totalLikes: { type: Number, default: 0 },
      totalComments: { type: Number, default: 0 }
    },
    vipBoard: [{
      isEmptySlot: { type: Boolean, default: true },
      slotPosition: { type: String },
      username: { type: String, default: "" },
      channelTitle: { type: String, default: "" },
      youtubeLink: { type: String, default: "" },
      clicks: { type: Number, default: 0 }
    }],
    activeBoard: [{
      isEmptySlot: { type: Boolean, default: true },
      username: { type: String, default: "" },
      channelTitle: { type: String, default: "" },
      youtubeLink: { type: String, default: "" },
      clicks: { type: Number, default: 0 }
    }],
    waitingList: [{
      userId: { type: String, required: true },
      username: { type: String, default: "" },
      channelTitle: { type: String, default: "" },
      channelLink: { type: String, default: "" },
      youtubeLink: { type: String, default: "" },
      appearsReceived: { type: Number, default: 0 },
      voters: [{ type: String }] // Tracks userIds who already approved them
    }],
    restrictions: [{
      userId: { type: String, required: true },
      allowed: { type: Boolean, default: true },
      remainingTimeText: { type: String, default: "" },
      lockoutUntil: { type: Date, default: null }
    }]
  });
  YouTubeState = mongoose.model("YouTubeState", YouTubeStateSchema);
}

// Helper function to guarantee that a baseline global system document exists in MongoDB
async function getOrCreateSystemState() {
  let state = await YouTubeState.findOne();
  if (!state) {
    // Instantiate a fresh clean board structural layout matching front-end demands
    const defaultVip = [
      { isEmptySlot: true, slotPosition: "left-1" },
      { isEmptySlot: true, slotPosition: "left-2" },
      { isEmptySlot: true, slotPosition: "right-1" },
      { isEmptySlot: true, slotPosition: "right-2" }
    ];
    const defaultActive = Array(6).fill({ isEmptySlot: true });

    state = new YouTubeState({
      systemPhase: "REGULAR_PERIOD",
      sequenceIndex: 0,
      globalMetrics: { totalViews: 0, totalSubs: 0, totalLikes: 0, totalComments: 0 },
      vipBoard: defaultVip,
      activeBoard: defaultActive,
      waitingList: []
    });
    await state.save();
  }
  return state;
}


/* ---------------- PLATFORM RUNTIME API ROUTING ---------------- */

// 1. Live Synchronization Dashboard State Pipeline Engine
router.get("/api/state/sync-youtube", auth, async (req, res) => {
  try {
    const userId = req.query.userId || req.user.id || "UNKNOWN";
    const state = await getOrCreateSystemState();

    // Check user restriction status settings rules dynamically
    let userRestriction = state.restrictions.find(r => r.userId === userId);
    let allowed = true;
    let remainingTimeText = "";
    let isLockedOut = false;
    let remainingLockoutMs = 0;

    if (userRestriction) {
      if (userRestriction.lockoutUntil && userRestriction.lockoutUntil > new Date()) {
        isLockedOut = true;
        remainingLockoutMs = userRestriction.lockoutUntil - new Date();
        allowed = false;
        remainingTimeText = `Account restricted for another ${Math.ceil(remainingLockoutMs / 60000)} minute(s).`;
      }
    }

    res.json({
      activeBoard: state.activeBoard,
      waitingList: state.waitingList,
      vipBoard: state.vipBoard,
      systemPhase: state.systemPhase,
      sequenceIndex: state.sequenceIndex,
      globalMetrics: state.globalMetrics,
      userUploadRestriction: { allowed, remainingTimeText },
      userLockoutStatus: { isLockedOut, remainingLockoutMs }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to compile system telemetry layout stream state." });
  }
});

// 2. Complete Asset Target Engagement Actions Verification Tracking Pipeline
router.post("/api/action/visit-complete", auth, async (req, res) => {
  try {
    const { userId, boardType, targetIndex } = req.body;
    const state = await getOrCreateSystemState();

    // Max capacity boundary limits variables control definitions
    const totalSlots = state.vipBoard.length + state.activeBoard.length; 

    // Incremental validation of user task selection target index matching current system expectation rotation
    if (state.sequenceIndex !== (boardType === 'vip' ? targetIndex : state.vipBoard.length + targetIndex)) {
       return res.status(400).json({ error: "Interaction alignment verified out of sequence order rules constraints." });
    }

    // Process metric updates based on location type matched
    if (boardType === "vip" && state.vipBoard[targetIndex]) {
      state.vipBoard[targetIndex].clicks += 1;
    } else if (boardType === "regular" && state.activeBoard[targetIndex]) {
      state.activeBoard[targetIndex].clicks += 1;
    }

    // Step continuous counter increments across all dynamic boards references standard tracking loops
    state.globalMetrics.totalViews += 1;
    state.globalMetrics.totalSubs += 1;
    state.globalMetrics.totalLikes += 1;
    state.globalMetrics.totalComments += 1;

    // Advance sequence pointer smoothly and roll over cleanly if it exceeds boundaries
    state.sequenceIndex = (state.sequenceIndex + 1) % totalSlots;
    
    // Safety check: if the sequence point hits a vacant slot, auto-advance it to prevent getting stuck
    let attempts = 0;
    while (attempts < totalSlots) {
      let currentIsVip = state.sequenceIndex < state.vipBoard.length;
      let actualIdx = currentIsVip ? state.sequenceIndex : state.sequenceIndex - state.vipBoard.length;
      let targetSlot = currentIsVip ? state.vipBoard[actualIdx] : state.activeBoard[actualIdx];

      if (targetSlot && !targetSlot.isEmptySlot) {
        break; // Found a valid channel to view
      }
      state.sequenceIndex = (state.sequenceIndex + 1) % totalSlots;
      attempts++;
    }

    await state.save();
    res.json({ message: "Action tracked successfully", sequenceIndex: state.sequenceIndex });
  } catch (error) {
    res.status(500).json({ error: "Failed to persist interaction metrics record tracking safely." });
  }
});

// 3. Queue Positioning Approval Verification Routine System Loop (Appeals)
router.post("/api/action/appeal", auth, async (req, res) => {
  try {
    const { userId, targetUserId } = req.body;
    const state = await getOrCreateSystemState();

    const targetQueueItem = state.waitingList.find(item => item.userId === targetUserId);
    if (!targetQueueItem) {
      return res.status(404).json({ error: "Target asset allocation position missing or expired." });
    }

    // Check if current session profile has already voted on this specific allocation sequence block 
    if (targetQueueItem.voters.includes(userId)) {
      return res.status(400).json({ message: "You have already cast an approval voucher token layout check for this asset position." });
    }

    targetQueueItem.voters.push(userId);
    targetQueueItem.appearsReceived += 1;

    // Transition condition checking: shifts item from queue to active acceleration slot matrix if 3 approvals are hit
    if (targetQueueItem.appearsReceived >= 3) {
      // Find a vacant regular slot on the active board
      let vacantSlotIndex = state.activeBoard.findIndex(slot => slot.isEmptySlot);
      
      if (vacantSlotIndex !== -1) {
        state.activeBoard[vacantSlotIndex] = {
          isEmptySlot: false,
          username: targetQueueItem.username,
          channelTitle: targetQueueItem.channelTitle,
          youtubeLink: targetQueueItem.youtubeLink,
          clicks: 0
        };
        // Splice out clean from waiting room allocation structure maps records layout
        state.waitingList = state.waitingList.filter(item => item.userId !== targetUserId);
      }
    }

    await state.save();
    res.json({ message: "Position approval voucher token recorded systematically." });
  } catch (error) {
    res.status(500).json({ error: "Database exception thrown handling user verification pipeline flows." });
  }
});

// 4. Secure Promotion Asset Link Pipeline Input Validation Layer Engine
router.post("/api/submit-link", auth, async (req, res) => {
  try {
    const { youtubeLink, userId } = req.body;
    const state = await getOrCreateSystemState();

    // Locate calling identity metadata configurations inside database limits arrays parameters sets
    let userRestriction = state.restrictions.find(r => r.userId === userId);
    if (userRestriction && userRestriction.lockoutUntil && userRestriction.lockoutUntil > new Date()) {
      return res.status(403).json({ error: "Your asset upload capability pipeline remains restricted due to structural lockout criteria constraints rules." });
    }

    // Fetch account username information dynamically out of existing models structures if available
    let dynamicUsername = req.user.username || "User_" + userId.substring(0, 5);

    // Push asset directly into waiting structural pipeline matrices arrays queues records configuration layers
    state.waitingList.push({
      userId: userId,
      username: dynamicUsername,
      channelTitle: "YouTube Partner Video",
      channelLink: youtubeLink,
      youtubeLink: youtubeLink,
      appearsReceived: 0,
      voters: []
    });

    // Enforce temporal lockout restriction to avoid submission floods
    if (!userRestriction) {
      state.restrictions.push({
        userId: userId,
        allowed: false,
        remainingTimeText: "Next upload available after phase operational structural check execution resets.",
        lockoutUntil: new Date(Date.now() + 60 * 60 * 1000) // 1 Hour lockout lock step validation execution rules
      });
    } else {
      userRestriction.allowed = false;
      userRestriction.remainingTimeText = "Next upload available after phase operational structural check execution resets.";
      userRestriction.lockoutUntil = new Date(Date.now() + 60 * 60 * 1000);
    }

    await state.save();
    res.json({ message: "Video asset uploaded securely and transferred to the Live Waiting Queue!" });
  } catch (error) {
    res.status(500).json({ error: "Internal submission system validation layers failure processing entry rules." });
  }
});

module.exports = router;
