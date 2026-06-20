// page.js

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

// Helper Auth Middleware
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized access: Please login." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user; // Contains username/metadata depending on login schema
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired: Please re-authenticate." });
  }
}

/* ---------------- MONGODB SCHEMAS & MODELS ---------------- */

// Schema tracking the global systemic state of the board loops
const YTBoardStateSchema = new mongoose.Schema({
  appealingPeriodActive: { type: Boolean, default: false },
  appealingPeriodEnd: { type: Date, default: null },
  activeSequenceIndex: { type: Number, default: 0 } // Tracks which position needs to be clicked next (0 to 13)
});
const YTBoardState = mongoose.models.YTBoardState || mongoose.model("YTBoardState", YTBoardStateSchema);

// Schema tracking live entries inside the 14 interactive board spaces
const YTActiveSlotSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  youtubeChannel: { type: String, required: true },
  youtubeVideo: { type: String, required: true },
  isVip: { type: Boolean, default: false },
  sequencePosition: { type: Number, required: true }, // 0-3 (VIP), 4-13 (Regular)
  views: { type: Number, default: 0 },
  subs: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});
const YTActiveSlot = mongoose.models.YTActiveSlot || mongoose.model("YTActiveSlot", YTActiveSlotSchema);

// Schema tracking users holding in the queue matrix waiting list
const YTWaitingQueueSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  youtubeChannel: { type: String, required: true },
  youtubeVideo: { type: String, required: true },
  appealCount: { type: Number, default: 0 },
  appealedBy: { type: [String], default: [] }, // Array of userIds who lodged appeals to avoid duplicate voting
  timestamp: { type: Date, default: Date.now }
});
const YTWaitingQueue = mongoose.models.YTWaitingQueue || mongoose.model("YTWaitingQueue", YTWaitingQueueSchema);

// Schema tracking personal tracking variables (user metadata progression)
const YTUserProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  acceptedConditions: { type: Boolean, default: false },
  visitedChannels: { type: [String], default: [] }, // Array of ActiveSlot IDs successfully clicked
  activeSequenceIndex: { type: Number, default: 0 },
  cooldownUntil: { type: Date, default: null },
  appealBanUntil: { type: Date, default: null }
});
const YTUserProfile = mongoose.models.YTUserProfile || mongoose.model("YTUserProfile", YTUserProfileSchema);


/* ---------------- UTILITY HELPER FUNCTIONS ---------------- */

/**
 * Clean URL parameters to eliminate all tracking tags before database entry.
 */
function sanitizeYoutubeUrl(url) {
  if (!url) return "";
  try {
    const parsedUrl = new URL(url);
    // Delete known tracking parameters explicitly
    parsedUrl.searchParams.delete("si");
    parsedUrl.searchParams.delete("t");
    return parsedUrl.toString();
  } catch (e) {
    // If complex URL parsing fails, strip parameters using basic regex strings safely
    return url.split(/[?#]/)[0];
  }
}

/**
 * Autonomously fetches or initializes the unified operational core application configurations.
 */ 
async function getOrCreateSystemState() {
  let state = await YTBoardState.findOne();
  if (!state) {
    state = new YTBoardState({
      appealingPeriodActive: false,
      activeSequenceIndex: 0
    });
    await state.save();
  }
  return state;
}

async function processAppealingPeriodEnd() {
  console.log("=== processAppealingPeriodEnd STARTED ===");

  try {
    const activeSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });
    let waitingUsers = await YTWaitingQueue.find().sort({ timestamp: 1 });

    const rejectedUsers = waitingUsers.filter(u => u.appealCount >= 3);

    for (const rejected of rejectedUsers) {
      await YTUserProfile.findOneAndUpdate(
        { userId: rejected.userId },
        {
          appealBanUntil: new Date(Date.now() + (4 * 60 * 60 * 1000)),
          acceptedConditions: false,
          visitedChannels: []
        },
        { upsert: true }
      );

      await YTWaitingQueue.deleteOne({ _id: rejected._id });
    }

    waitingUsers = await YTWaitingQueue.find().sort({ timestamp: 1 });
      
    // First 10 waiting users get priority
    const promotedUsers = waitingUsers.slice(0, 10);

    // Regular active slots only (4-13)
    const regularActiveSlots = activeSlots.filter(s => s.sequencePosition >= 4);

    // Apply cooldown and clear ALL regular active slots completely from the board
    for (const slot of regularActiveSlots) {
      await YTUserProfile.findOneAndUpdate(
        { userId: slot.userId },
        {
          cooldownUntil: new Date(Date.now() + (3 * 60 * 60 * 1000)),
          acceptedConditions: false,
          visitedChannels: []
        },
        { upsert: true }
      );

      await YTActiveSlot.deleteOne({ _id: slot._id });
    }

    // Sequentially insert promoted users into clear incremental positions (4 to 13)
    for (let i = 0; i < promotedUsers.length; i++) {
      const user = promotedUsers[i];
      const targetPos = 4 + i;

      await YTActiveSlot.create({
        userId: user.userId,
        username: user.username,
        youtubeChannel: user.youtubeChannel,
        youtubeVideo: user.youtubeVideo,
        sequencePosition: targetPos,
        isVip: false
      });

      await YTWaitingQueue.deleteOne({ _id: user._id });
    }

    await YTActiveSlot.updateMany(
      { sequencePosition: { $gte: 4 } },
      { $set: { views: 0, subs: 0, likes: 0, comments: 0 } }
    );
    await YTUserProfile.updateMany(
      {}, 
      { $set: { visitedChannels: [], activeSequenceIndex: 0 } }
    );
    console.log("=== processAppealingPeriodEnd FINISHED ===");

  } catch (err) {
    console.error("processAppealingPeriodEnd ERROR:", err);
    throw err;
  }
}


/* ---------------- ROUTER ROUTE CHANNELS API ---------------- */

/**
 * GET /api/youtube-dashboard/state
 * Assembles and structuralizes the precise state array display matrix.
 */
router.get("/api/youtube-dashboard/state", auth, async (req, res) => {
  try {
    const User = mongoose.model("User");
    
    // ==================== FIXED JWT OBJECT MATCH BUG ====================
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    if (!dbUser) return res.status(404).json({ error: "Profile node missing." });
    
    const userId = dbUser._id.toString();
    
    // Fetch or create tracking user profile information
    let userProfile = await YTUserProfile.findOne({ userId });
    if (!userProfile) {
      userProfile = new YTUserProfile({ userId });
      await userProfile.save();
    }

    const sysState = await getOrCreateSystemState();
    
    // Process system clock variables for Appealing Period
    let appealingPeriod = { isActive: false, countdownText: "00:00", phase: 0 };
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const now = Date.now();
      const end = new Date(sysState.appealingPeriodEnd).getTime();
      const remainingMs = end - now;

      // ==================== FIXED LOGICAL BRACKETS HERE ====================
      if (remainingMs <= 0) {
        // If 1-Minute Upload Grace Phase (Marker 999) just ended, transition immediately to the 10-minute Appeal Window!
        if (sysState.activeSequenceIndex === 999) {
          sysState.activeSequenceIndex = 0; // reset temporary tracker marker
          sysState.appealingPeriodEnd = new Date(Date.now() + 10 * 60000); // 10-minute Appealing Period starts now
          await sysState.save();
        } else {
          // ATOMIC LOCK: Only executes when the remainingMs is explicitly <= 0
          const lockedState = await YTBoardState.findOneAndUpdate(
            { _id: sysState._id, appealingPeriodActive: true }, 
            { $set: { appealingPeriodActive: false, appealingPeriodEnd: null } },
            { new: false } // Crucial: Returns the state BEFORE the update
          );

          // Check if this specific concurrent request won the database modification race
          if (lockedState && lockedState.appealingPeriodActive === true) {
            console.log("SUCCESS: This instance won the lock. Processing cleanup...");
            await processAppealingPeriodEnd();
          } else {
            console.log("BLOCKED: Cleanup already handled by another concurrent request.");
          }
        }
      } else {
        // This block now safely runs exclusively when time is still active (remainingMs > 0)
        appealingPeriod.isActive = true;
        const totalSecs = Math.floor(remainingMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        appealingPeriod.countdownText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        if (sysState.activeSequenceIndex === 999) {
          appealingPeriod.phase = 0; // Custom Phase 0: 1-Minute Upload Grace Phase
        } else if (totalSecs > 240) {
          appealingPeriod.phase = 1; // Phase 1: Main Appeal phase
        } else {
          appealingPeriod.phase = 2; // Phase 2: Targeted verification phase
        }
      }
    }

    // Process board layouts (First 10 users rules apply dynamically)
    const activeSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });
    
    // Check if the current logged-in user (waiting list user) was appealed by any active slot user
    const myQueueRecord = await YTWaitingQueue.findOne({ userId });

    let vipChannels = [];
    let regularChannels = [];

    // Initialize 4 VIP slots structures explicitly
    for (let i = 0; i < 4; i++) {
      const match = activeSlots.find(s => s.sequencePosition === i);
      if (match) {
        const stringAppealers = myQueueRecord ? myQueueRecord.appealedBy.map(id => id.toString()) : [];
        const wasAppealedByThisActiveUser = match.userId && stringAppealers.includes(match.userId.toString());
        const hasVisited = userProfile.visitedChannels.includes(match._id.toString());
        
        vipChannels.push({
          ...match.toObject(),
          canVisitTargeted: appealingPeriod.phase === 2 && !!wasAppealedByThisActiveUser && !hasVisited
        });
      } else {
        vipChannels.push({ empty: true, sequencePosition: i });
      }
    }

    // Initialize 10 Standard slots structures explicitly
    for (let i = 4; i < 14; i++) {
      const match = activeSlots.find(s => s.sequencePosition === i);
      if (match) {
        const stringAppealers = myQueueRecord ? myQueueRecord.appealedBy.map(id => id.toString()) : [];
        const wasAppealedByThisActiveUser = match.userId && stringAppealers.includes(match.userId.toString());
        const hasVisited = userProfile.visitedChannels.includes(match._id.toString());
        
        regularChannels.push({
          ...match.toObject(),
          canVisitTargeted: appealingPeriod.phase === 2 && !!wasAppealedByThisActiveUser && !hasVisited
        });
      } else {
        regularChannels.push({ empty: true, sequencePosition: i });
      }
    }

    // Count non-empty boards items to see if client needs to complete requirements
    const realActiveCount = activeSlots.length;
    const userIsActiveOnBoard = activeSlots.some(s => s.userId.toString() === userId.toString());
    
    // Compute interactive button behaviors
    const vipSlots = activeSlots.filter(s => s.sequencePosition < 4);
    const regularSlots = activeSlots.filter(s => s.sequencePosition >= 4);

    // Decide correct starting point
    let startIndex = 0;
    if (vipSlots.length > 0) {
      startIndex = vipSlots.sort((a, b) => a.sequencePosition - b.sequencePosition)[0].sequencePosition;
    } else if (regularSlots.length > 0) {
      startIndex = regularSlots.sort((a, b) => a.sequencePosition - b.sequencePosition)[0].sequencePosition;
    }

    const isActiveOnBoard = await YTActiveSlot.exists({ userId });
    const isInWaitingList = await YTWaitingQueue.exists({ userId });

    // compute base state
    let buttonSystemState = {
      disabled: false,
      activeSequenceIndex: userProfile.activeSequenceIndex || startIndex
    };

    if (isActiveOnBoard || isInWaitingList) {
      buttonSystemState.disabled = true;
      buttonSystemState.lockReason = "SYSTEM_MEMBER_NO_VISIT";
    }

    // Allow interaction only if the user has target verification visits remaining in Phase 2
    if (appealingPeriod.isActive) {
      if (appealingPeriod.phase === 2) {
        const hasTargetedVisitsLeft = [...vipChannels, ...regularChannels].some(c => c.canVisitTargeted === true);
        buttonSystemState.disabled = !hasTargetedVisitsLeft;
      } else {
        buttonSystemState.disabled = true;
      }
    }

    // Format Queue List Data with type-safe checks and cross-referenced accuser objects
    const rawQueue = await YTWaitingQueue.find().sort({ timestamp: 1 });
    const waitingListUsers = [];
    let loggedInUserHasVisitsLeft = false;

    for (const q of rawQueue) {
      const accusersDetails = [];
      
      for (const accuserUserId of q.appealedBy) {
        const activeMatch = activeSlots.find(s => s.userId.toString() === accuserUserId.toString());
        if (activeMatch) {
          const canVisit = (appealingPeriod.phase === 2);
          
          if (canVisit && q.userId.toString() === userId.toString()) {
            loggedInUserHasVisitsLeft = true;
          }

          accusersDetails.push({
            activeSlotId: activeMatch._id.toString(),
            username: activeMatch.username,
            canVisitTargeted: canVisit 
          });
        }
      }
      waitingListUsers.push({
        id: q._id.toString(),
        userId: q.userId,
        username: q.username,
        youtubeChannel: q.youtubeChannel,
        appealCount: q.appealCount,
        appealedBy: q.appealedBy, 
        canBeAppealedByMe: appealingPeriod.phase === 1 && !q.appealedBy.includes(userId) && q.userId !== userId,
        accusers: accusersDetails 
      });
    }

    // Master Button System Overrides to lift the standard lockout wall exclusively during Phase 2
    if (appealingPeriod.isActive && appealingPeriod.phase === 2) {
      if (isInWaitingList) {
        if (loggedInUserHasVisitsLeft) {
          buttonSystemState.disabled = false;
          delete buttonSystemState.lockReason; 
        } else {
          buttonSystemState.disabled = true;
          buttonSystemState.lockReason = "TARGETED_VISITS_COMPLETED";
        }
      } else {
        buttonSystemState.disabled = true;
        buttonSystemState.lockReason = "ACTIVE_USERS_FROZEN";
      }
    }

    // Calculate status of lower promotional interaction forms zones
    let controlZoneState = { status: "INITIAL_GATEWAY" };
    
    if (!userProfile.acceptedConditions) {
      controlZoneState.status = "INITIAL_GATEWAY";
    } else if (userProfile.appealBanUntil && userProfile.appealBanUntil > new Date()) {
      controlZoneState.status = "LOCKDOWN_APPEALS";
      controlZoneState.remainingMinutes = Math.ceil((userProfile.appealBanUntil - new Date()) / 60000);
    } else if (userProfile.cooldownUntil && userProfile.cooldownUntil > new Date()) {
      controlZoneState.status = "LOCKDOWN_COOLDOWN";
      controlZoneState.remainingMinutes = Math.ceil((userProfile.cooldownUntil - new Date()) / 60000);
    } else {
      if (appealingPeriod.isActive && appealingPeriod.phase === 2) {
        if (isInWaitingList && loggedInUserHasVisitsLeft) {
          controlZoneState.status = "TARGETED_VERIFICATION_ACTIVE";
        } else {
          controlZoneState.status = "TRACKING_SECURITY";
        }
      } else if (userIsActiveOnBoard || (!!myQueueRecord && appealingPeriod.phase !== 2)) {
        controlZoneState.status = "TRACKING_SECURITY";
      } else if (appealingPeriod.isActive && appealingPeriod.phase === 0) {
        let targetedSlotsToClick = activeSlots.map(s => s._id.toString());
        const finishedAllVisits = targetedSlotsToClick.every(id => userProfile.visitedChannels.includes(id));

        if (finishedAllVisits && !userIsActiveOnBoard && !myQueueRecord) {
          controlZoneState.status = "UNLOCKED";
        } else {
          controlZoneState.status = "FROZEN_APPEALING";
        }
      } else if (appealingPeriod.isActive && appealingPeriod.phase === 1) {
        controlZoneState.status = "FROZEN_APPEALING";
      } else {
        let targetedSlotsToClick = activeSlots.map(s => s._id.toString());
        const finishedAllVisits = targetedSlotsToClick.every(id => userProfile.visitedChannels.includes(id));

        if (realActiveCount < 10) {
          controlZoneState.status = "UNLOCKED";
        } else if (!finishedAllVisits) {
          controlZoneState.status = "VISITS_INCOMPLETE";
        } else {
          controlZoneState.status = "UNLOCKED";
        }
      }
    }
    res.json({
      userAccount: { username: dbUser.username, channelUrl: dbUser.youtubeChannel || "https://youtube.com/channel_placeholder" },
      appealingPeriod,
      vipChannels,
      regularChannels,
      visitedChannelIds: userProfile.visitedChannels,
      buttonSystemState,
      waitingListUsers,
      userIsActiveOnBoard,
      controlZoneState
    });

  } catch (err) {
    console.error("STATE ROUTE ERROR:", err);
    res.status(500).json({
      error: "State compilation failure",
      details: err.message
    });
  }
});

/**
 * POST /api/youtube-dashboard/accept-conditions
 */
router.post("/api/youtube-dashboard/accept-conditions", auth, async (req, res) => {
  try {
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    if (!dbUser) return res.status(404).json({ error: "User identity unverified" });

    await YTUserProfile.findOneAndUpdate(
      { userId: dbUser._id.toString() },
      { acceptedConditions: true },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Condition registration fault" });
  }
});

/**
 * POST /api/youtube-dashboard/verify-visit
 */
router.post("/api/youtube-dashboard/verify-visit", auth, async (req, res) => {
  try {
    const { elementId, sequencePosition } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const userId = dbUser._id.toString();  

    // 1. CHECK THE EXISTING SEQUENTIAL TIMELOCK
    const userProfileCheck = await YTUserProfile.findOne({ userId });
    const nowTime = new Date();

    if (userProfileCheck && userProfileCheck.lastVisitAt) {
      const timePassed = Date.now() - new Date(userProfileCheck.lastVisitAt).getTime();
      if (timePassed < 3000) {
        return res.status(429).json({
          error: "Please wait before clicking again.",
          cooldownSeconds: Math.ceil((3000 - timePassed) / 1000),
          elementId: userProfileCheck.lastVisitElementId || elementId 
        });
      }
    }

    const sysState = await getOrCreateSystemState();
    const slot = await YTActiveSlot.findById(elementId);
    if (!slot) return res.status(404).json({ error: "Target node profile shifted or expired." });

    // Calculate exactly if we are in Phase 2
    let isPhase2Visit = false;
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const remainingMs = new Date(sysState.appealingPeriodEnd).getTime() - Date.now();
      const totalSecs = Math.floor(remainingMs / 1000);
      if (totalSecs <= 240 && totalSecs > 0 && sysState.activeSequenceIndex !== 999) {
        isPhase2Visit = true;
      }
    }

    const isActiveOnBoard = await YTActiveSlot.findOne({ userId });
    const myQueueRecord = await YTWaitingQueue.findOne({ userId });

    // STRICT PHASE 2 GATEWAY
    if (sysState.appealingPeriodActive) {
    if (!isPhase2Visit) {
        return res.status(403).json({ error: "Visits are frozen during appealing phase." });
      }

      const stringAppealers = myQueueRecord && myQueueRecord.appealedBy ? myQueueRecord.appealedBy.map(id => String(id).trim()) : [];
      const targetActiveOwnerId = String(slot.userId).trim();

      if (!myQueueRecord || !stringAppealers.includes(targetActiveOwnerId)) {
        return res.status(403).json({ error: "Access Denied: Unapproved validation channel target." });
      }
    } else {
      // Normal Operation Mode: Members inside the system cannot use standard visits
      if (isActiveOnBoard || myQueueRecord) {
        return res.status(403).json({
          error: "You are no longer allowed to visit other channels."
        });
      }
    }

    if (userProfileCheck?.appealBanUntil && userProfileCheck.appealBanUntil > new Date()) {
      return res.status(403).json({ error: "Appeal lockdown active" });
    }

    if (userProfileCheck?.cooldownUntil && userProfileCheck.cooldownUntil > new Date()) {
      return res.status(403).json({ error: "Cooldown active" });
    }

    // EXPLOIT PROTECTION: Check if this user already recorded a successful visit on this item
    const hasAlreadyVisited = userProfileCheck && userProfileCheck.visitedChannels.includes(elementId);
    let currentSlotData = slot;

    // ONLY increment counter increments if it's a normal operation visit loop
    if (!isPhase2Visit && !hasAlreadyVisited) {
      currentSlotData = await YTActiveSlot.findByIdAndUpdate(
        elementId,
        { $inc: { views: 1, subs: 1, likes: 1, comments: 1 } },
        { new: true }
      );
    }

    // Setup atomic object to store changes locally in server memory
    let profileUpdates = {
      ...(isPhase2Visit ? {} : { $addToSet: { visitedChannels: elementId } }),
      $set: {
        lastVisitElementId: elementId,
        lastVisitAt: nowTime
      }
    };

    // Phase 2 early return route: Allows infinite clicks by safely resolving without tracking blockers
    if (isPhase2Visit) {
      await YTUserProfile.findOneAndUpdate({ userId }, profileUpdates, { upsert: true });
      return res.json({ success: true });
    }
    
    // Fetch all slots to update user sequencing and run the threshold calculation
    const activeSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });

    // Sync array data references for threshold checks
    const slotIndex = activeSlots.findIndex(s => s._id.toString() === elementId);
    if (slotIndex !== -1) {
      activeSlots[slotIndex] = currentSlotData;
    }

    // Find next non-empty positional coordinate in layout list
    let nextIndex = sequencePosition + 1;
    let lookupsAttempted = 0;
    let foundNextSlot = false;

    while (lookupsAttempted < 14) {
      if (nextIndex >= 14) nextIndex = 0;
      
      const checkNext = activeSlots.find(s => s.sequencePosition === nextIndex);
      if (checkNext) {
        profileUpdates.$set.activeSequenceIndex = nextIndex;
        foundNextSlot = true;
        break;
      }
      nextIndex++;
      lookupsAttempted++;
    }

    let responsePayload = { success: true, systemAlertMessage: null };

    // Start appealing period ONLY when every active user has reached 10 interactions
    const allUsersReachedTen = activeSlots.length >= 10 &&
      activeSlots.every(slot =>
        slot.views >= 10 &&
        slot.subs >= 10 &&
        slot.likes >= 10 &&
        slot.comments >= 10
      );

    if (allUsersReachedTen) {
      sysState.appealingPeriodActive = true;
      sysState.appealingPeriodEnd = new Date(Date.now() + 1 * 60000); // 1-Minute Upload Grace Phase triggers first!
      sysState.activeSequenceIndex = 999; // Temporary marker denoting system is currently in Phase 0
      
      const resetIndex = activeSlots.length > 0 ? activeSlots[0].sequencePosition : 0;
      profileUpdates.$set.activeSequenceIndex = resetIndex;

      responsePayload.systemAlertMessage = "txtUploadFormFrozen";
    }

    // Commit a single, consolidated atomic database write safely
    await YTUserProfile.findOneAndUpdate({ userId }, profileUpdates, { upsert: true });
    await sysState.save();
    
    res.json(responsePayload);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Visit verification process crash" });
  }
});

/**
 * POST /api/youtube-dashboard/submit-promotion
 */
router.post("/api/youtube-dashboard/submit-promotion", auth, async (req, res) => {
  try {
    let { rawVideoUrl, rawChannelUrl } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const userId = dbUser._id.toString();
    const userProfile = await YTUserProfile.findOne({ userId });
   const alreadyExists = await YTActiveSlot.findOne({ userId });
    if (alreadyExists) {
      return res.status(400).json({ errorKey: "txtSingleUploadSecurity" });
    }
    if (
      userProfile?.appealBanUntil &&
      userProfile.appealBanUntil > new Date()
    ) {
      return res.status(403).json({
        error: "Appeal lockdown active"
      });
    }

    if (
      userProfile?.cooldownUntil &&
      userProfile.cooldownUntil > new Date()
    ) {
      return res.status(403).json({
        error: "Cooldown active"
      });
    }

    // Perform URL filtering sanitization arrays right away inside backend
    const cleanVideoUrl = sanitizeYoutubeUrl(rawVideoUrl);
    const cleanChannelUrl = sanitizeYoutubeUrl(rawChannelUrl);

    // Enforce basic structured regex parameter filters
    if (!cleanVideoUrl.includes("youtube.com") && !cleanVideoUrl.includes("youtu.be")) {
      return res.status(400).json({ errorKey: "validationErrorLink" });
    }

    // Verify user is not altering designated tracked accounts documents outside database profile records
    if (dbUser.youtubeChannel && sanitizeYoutubeUrl(dbUser.youtubeChannel) !== cleanChannelUrl) {
      return res.status(400).json({ errorKey: "securityErrorProfile" });
    }

    // Determine board sequence assignment patterns using First Ten Rules
    const currentActiveSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });
    
    let targetPosition = -1;

    for (let i = 4; i < 14; i++) {
      const exists = await YTActiveSlot.findOne({ sequencePosition: i });

      if (!exists) {
        targetPosition = i;

        await YTActiveSlot.create({
          userId,
          username: dbUser.username,
          youtubeChannel: cleanChannelUrl,
          youtubeVideo: cleanVideoUrl,
          sequencePosition: i,
          isVip: false
        });

        break;
      }
    }

    // If board is full, push item into waiting line queue list instead
    if (targetPosition === -1) {
      const inQueue = await YTWaitingQueue.findOne({ userId });
      if (!inQueue) {
        const newQueueNode = new YTWaitingQueue({
          userId,
          username: dbUser.username,
          youtubeChannel: cleanChannelUrl,
          youtubeVideo: cleanVideoUrl
        });
        await newQueueNode.save();
      }
      return res.json({ successKey: "txtSingleUploadSecurity" });
    }
    
    // Reset user tracking arrays history values to guarantee complete sequential viewing tracking
    await YTUserProfile.findOneAndUpdate(
      { userId },
      {
        visitedChannels: [],
        activeSequenceIndex: 0
      }
    );

    // Sync baseline index sequence positions to avoid layout locks
 return res.json({ successKey: "txtPromoZoneUnlocked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Promotion submission cycle break" });
  }
});

/**
 * POST /api/youtube-dashboard/appeal-user
 */
router.post("/api/youtube-dashboard/appeal-user", auth, async (req, res) => {
  try {
    const { queueUserId } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const currentOperatorId = dbUser._id.toString();
    const isActiveUser = await YTActiveSlot.findOne({
      userId: currentOperatorId
    });

    if (!isActiveUser) {
      return res.status(403).json({
        error: "Only active users can submit appeals."
      });
    }

    const myAppealsCount = await YTWaitingQueue.countDocuments({
      appealedBy: currentOperatorId
    });

    if (myAppealsCount >= 3) {
      return res.status(400).json({
        error: "You have already used all 3 appeals."
      });
    }

    // ==================== FIXED DATE MATH COERCION SUBTRACTION ERROR ====================
    const sysState = await getOrCreateSystemState();
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const remainingMs = new Date(sysState.appealingPeriodEnd).getTime() - Date.now();
      if (Math.floor(remainingMs / 1000) <= 240) {
        return res.status(400).json({ error: "Appealing phase window has closed. Verification window active." });
      }
    } else {
      return res.status(400).json({ error: "Appealing process is not active." });
    }

    const queueRecord = await YTWaitingQueue.findById(queueUserId);
    if (!queueRecord) return res.status(404).json({ error: "Queue element targeted not found." });

    if (queueRecord.appealedBy.includes(currentOperatorId)) {
      return res.status(400).json({ error: "Operator verification note already documented on this slot vector." });
    }

    // Register parameters adjustments inside document arrays fields safely
    queueRecord.appealCount += 1;
    queueRecord.appealedBy.push(currentOperatorId);
    await queueRecord.save();

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Validation query system process fault" });
  }
});

module.exports = router;
