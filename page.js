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
  const activeSlots = await YTActiveSlot.find()
    .sort({ sequencePosition: 1 });

  let waitingUsers = await YTWaitingQueue.find()
    .sort({ timestamp: 1 });

  const rejectedUsers = waitingUsers.filter(
    u => u.appealCount >= 3
  );

  for (const rejected of rejectedUsers) {
    await YTUserProfile.findOneAndUpdate(
      { userId: rejected.userId },
      {
        appealBanUntil:
          new Date(Date.now() + (4 * 60 * 60 * 1000)),
        acceptedConditions: false,
        visitedChannels: []
      },
      { upsert: true }
    );

    await YTWaitingQueue.deleteOne({
      _id: rejected._id
    });
  }

  waitingUsers = await YTWaitingQueue.find()
    .sort({ timestamp: 1 });
    
  // First 10 waiting users get priority
  const promotedUsers = waitingUsers.slice(0, 10);

  // Regular active slots only (4-13)
  const regularActiveSlots = activeSlots.filter(
    s => s.sequencePosition >= 4
  );

  // How many waiting users are available
  const waitingCount = promotedUsers.length;

  // Number of active users that must be replaced
  const replacementCount = waitingCount;

  // Shuffle active users randomly
  const shuffled = [...regularActiveSlots].sort(
    () => Math.random() - 0.5
  );

  // Select users that will be removed
  const replacedUsers = shuffled.slice(
    0,
    replacementCount
  );

  // Apply cooldown only to replaced users
  for (const slot of replacedUsers) {
    await YTUserProfile.findOneAndUpdate(
      { userId: slot.userId },
      {
        cooldownUntil:
          new Date(Date.now() + (3 * 60 * 60 * 1000)),
        acceptedConditions: false,
        visitedChannels: []
      },
      { upsert: true }
    );

    await YTActiveSlot.deleteOne({
      _id: slot._id
    });
  }

  // Collect available positions
  const freePositions = replacedUsers.map(
    s => s.sequencePosition
  ).sort((a, b) => a - b);
  console.log("promotedUsers:", promotedUsers.length);
console.log("replacedUsers:", replacedUsers.length);
console.log("freePositions:", freePositions);
  // Insert promoted users into freed positions
  for (let i = 0; i < promotedUsers.length; i++) {
    const user = promotedUsers[i];

    await YTActiveSlot.create({
      userId: user.userId,
      username: user.username,
      youtubeChannel: user.youtubeChannel,
      youtubeVideo: user.youtubeVideo,
      sequencePosition: freePositions[i],
      isVip: false
    });

    await YTWaitingQueue.deleteOne({
  _id: user._id
});
}

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
    const dbUser = await User.findOne({ username: req.user });
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
      if (remainingMs <= 0) {
        await processAppealingPeriodEnd();

        sysState.appealingPeriodActive = false;
        sysState.appealingPeriodEnd = null;

        await sysState.save();
      }
      else {
        appealingPeriod.isActive = true;
        const totalSecs = Math.floor(remainingMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        appealingPeriod.countdownText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        // Phase 1 (Appealing window): First 2 mins (Remaining time: 180s down to 60s)
        // Phase 2 (Targeted Visit window): Last 1 min (Remaining time: under 60s)
        if (totalSecs > 60) {
          appealingPeriod.phase = 1; 
        } else {
          appealingPeriod.phase = 2;
        }
      }
    }

    // Process board layouts (First 10 users rules apply dynamically)
    const activeSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });
    
    // Check if the current logged-in user (waiting list user) was appealed by any active slot user
    // We fetch all waiting queue slots where this user might be listed to see who appealed them
    const myQueueRecord = await YTWaitingQueue.findOne({ userId });

    let vipChannels = [];
    let regularChannels = [];

    // Initialize 4 VIP slots structures explicitly
    for (let i = 0; i < 4; i++) {
      const match = activeSlots.find(s => s.sequencePosition === i);
      if (match) {
        // In Phase 2, if this active user appealed against me, allow me to visit them
        const wasAppealedByThisActiveUser = myQueueRecord && myQueueRecord.appealedBy.includes(match.userId);
        const hasVisited = userProfile.visitedChannels.includes(match._id.toString());
        
        vipChannels.push({
          ...match.toObject(),
          canVisitTargeted: appealingPeriod.phase === 2 && wasAppealedByThisActiveUser && !hasVisited
        });
      } else {
        vipChannels.push({ empty: true, sequencePosition: i });
      }
    }

    // Initialize 10 Standard slots structures explicitly
    for (let i = 4; i < 14; i++) {
      const match = activeSlots.find(s => s.sequencePosition === i);
      if (match) {
        // In Phase 2, if this active user appealed against me, allow me to visit them
        const wasAppealedByThisActiveUser = myQueueRecord && myQueueRecord.appealedBy.includes(match.userId);
        const hasVisited = userProfile.visitedChannels.includes(match._id.toString());
        
        regularChannels.push({
          ...match.toObject(),
          canVisitTargeted: appealingPeriod.phase === 2 && wasAppealedByThisActiveUser && !hasVisited
        });
      } else {
        regularChannels.push({ empty: true, sequencePosition: i });
      }
    }

    // Count non-empty boards items to see if client needs to complete requirements
    const realActiveCount = activeSlots.length;
    const userIsActiveOnBoard = activeSlots.some(s => s.userId === userId);

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

// ❌ YOUR RULE: system users cannot visit
if (isActiveOnBoard || isInWaitingList) {
  buttonSystemState.disabled = true;
  buttonSystemState.lockReason = "SYSTEM_MEMBER_NO_VISIT";
}
    if (appealingPeriod.isActive) {
      buttonSystemState.disabled = true;
    }

    // Format Queue List Data with targeted security flags
    const rawQueue = await YTWaitingQueue.find().sort({ timestamp: 1 });
    const waitingListUsers = rawQueue.map(q => ({
      id: q._id.toString(),
      youtubeChannel: q.youtubeChannel,
      appealCount: q.appealCount,
      appealedBy: q.appealedBy, // Show who appealed them during the phase windows
      canBeAppealedByMe: appealingPeriod.phase === 1 && !q.appealedBy.includes(userId) && q.userId !== userId
    }));

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
      const alreadyInSystem = userIsActiveOnBoard || !!myQueueRecord;
      if (alreadyInSystem && appealingPeriod.phase !== 2) {
        controlZoneState.status = "TRACKING_SECURITY";
      } else if (appealingPeriod.isActive && appealingPeriod.phase === 1) {
        controlZoneState.status = "FROZEN_APPEALING";
      } else {
        // User must click all occupied operational board items to clear verification sequences
        let targetedSlotsToClick = activeSlots.map(s => s._id.toString());
        const finishedAllVisits = targetedSlotsToClick.every(id => userProfile.visitedChannels.includes(id));

        // Bootstrap mode until 10 standard slots are filled
        if (realActiveCount < 10) {
          controlZoneState.status = "UNLOCKED";
        }
        else if (!finishedAllVisits) {
          controlZoneState.status = "VISITS_INCOMPLETE";
        }
        else {
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
    const dbUser = await User.findOne({ username: req.user });
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
    const dbUser = await User.findOne({ username: req.user });
    const userId = dbUser._id.toString();  
    // === PASTE THIS NEW CODE BLOCK HERE ===
    const userProfileCheck = await YTUserProfile.findOne({ userId });
    if (userProfileCheck && userProfileCheck.lastVisitAt) {
      const timePassed = Date.now() - new Date(userProfileCheck.lastVisitAt).getTime();
      if (timePassed < 30000) {
        return res.status(429).json({
          error: "Please wait before clicking again.",
          cooldownSeconds: Math.ceil((30000 - timePassed) / 1000),
          elementId
        });
      }
    }

    const userProfile = await YTUserProfile.findOneAndUpdate(
      { userId },
      {
        lastVisitElementId: elementId,
        lastVisitAt: new Date()
      },
      { new: true, upsert: true }
    );
    // === END OF NEW CODE BLOCK ===

    const isActiveOnBoard = await YTActiveSlot.findOne({ userId });
const isInWaitingList = await YTWaitingQueue.findOne({ userId });

// ❌ Once user enters system (active OR waiting), they lose visit rights
if (isActiveOnBoard || isInWaitingList) {
  return res.status(403).json({
    error: "You are no longer allowed to visit other channels."
  });
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
    const slot = await YTActiveSlot.findById(elementId);
    if (!slot) return res.status(404).json({ error: "Target node profile shifted or expired." });
    const sysState = await getOrCreateSystemState();

    // Block all visits unless the appealing period is active
    if (sysState.appealingPeriodActive) {

  const remainingMs =
    sysState.appealingPeriodEnd - new Date();

  const totalSecs =
    Math.floor(remainingMs / 1000);

  if (totalSecs > 60) {
    return res.status(403).json({
      error:
        "Visits are completely frozen during the appealing phase."
    });
  }

  const myQueueRecord =
    await YTWaitingQueue.findOne({ userId });

  if (
    !myQueueRecord ||
    !myQueueRecord.appealedBy.includes(slot.userId)
  ) {
    return res.status(403).json({
      error:
        "Unauthorized visit."
    });
  }
}


    // During Phase 2 we only record the verification visit.
// No views, likes, subs, or comments are added.

const isPhase2Visit =
  sysState.appealingPeriodActive &&
  sysState.appealingPeriodEnd &&
  Math.floor(
    (sysState.appealingPeriodEnd - new Date()) / 1000
  ) <= 60;

if (!isPhase2Visit) {
  slot.views += 1;
  slot.subs += 1;
  slot.likes += 1;
  slot.comments += 1;
  await slot.save();
}

// Record visit regardless of phase
await YTUserProfile.findOneAndUpdate(
  { userId },
  { $addToSet: { visitedChannels: elementId } }
);

    // If it's a Phase 2 verification visit, we bypass index modifications and just exit successfully
    if (sysState.appealingPeriodActive) {
      return res.json({ success: true });
    }

    // 3. Increment board indexing values or launch Appealing Period rules engine dynamically
    const activeSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });
    
    // Find next non-empty positional coordinate in layout list
    let nextIndex = sequencePosition + 1;
    let lookupsAttempted = 0;
    let foundNextSlot = false;

    while (lookupsAttempted < 14) {
      if (nextIndex >= 14) nextIndex = 0;
      
      const checkNext = activeSlots.find(s => s.sequencePosition === nextIndex);
      if (checkNext) {
        userProfile.activeSequenceIndex = nextIndex;
await userProfile.save();

foundNextSlot = true;
break;
      }
      nextIndex++;
      lookupsAttempted++;
    }

    let responsePayload = { success: true, systemAlertMessage: null };

    // If current user just clicked the last active item on the sequence rotation, trigger validation audits phase
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
  sysState.appealingPeriodEnd = new Date(Date.now() + 3 * 60000);
  userProfile.activeSequenceIndex =
  activeSlots.length > 0
    ? activeSlots[0].sequencePosition
    : 0;

await userProfile.save();

  responsePayload.systemAlertMessage = "txtUploadFormFrozen";
}

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
    const dbUser = await User.findOne({ username: req.user });
    const userId = dbUser._id.toString();
    const userProfile = await YTUserProfile.findOne({ userId });
    const alreadyExists = await YTActiveSlot.findOne({ userId });
if (alreadyExists) {
  return res.json({ successKey: "txtSingleUploadSecurity" });
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

    // Populate slot using direct data variables inputs without dummy seed variables placeholder logic
    
    // Reset user tracking arrays history values to guarantee complete sequential viewing tracking
    await YTUserProfile.findOneAndUpdate(
  { userId },
  {
    visitedChannels: [],
    activeSequenceIndex: 0
  }
);

    // Sync baseline index sequence positions to avoid layout locks
    const sysState = await getOrCreateSystemState();
    const updatedSlots = await YTActiveSlot.find().sort({ sequencePosition: 1 });

    res.json({ successKey: "txtPromoZoneUnlocked" });

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
    const dbUser = await User.findOne({ username: req.user });
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

    // Securely check if we are in Phase 1 (Appealing Window)
    const sysState = await getOrCreateSystemState();
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const remainingMs = sysState.appealingPeriodEnd - new Date();
      if (Math.floor(remainingMs / 1000) <= 60) {
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
