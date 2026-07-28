// page2.js — Instagram Dashboard Router

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { connectToDatabase } = require("./lib/db");
const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

// Helper Auth Middleware
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized access: Please login." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired: Please re-authenticate." });
  }
}

/* ---------------- MONGODB SCHEMAS & MODELS ---------------- */

// Schema tracking the global systemic state of the board loops (Instagram)
const IGBoardStateSchema = new mongoose.Schema({
  appealingPeriodActive: { type: Boolean, default: false },
  appealingPeriodEnd: { type: Date, default: null },
  activeSequenceIndex: { type: Number, default: 0 }
});
const IGBoardState = mongoose.models.IGBoardState || mongoose.model("IGBoardState", IGBoardStateSchema);

// Schema tracking live entries inside the 14 interactive board spaces
const IGActiveSlotSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  instagramChannel: { type: String, required: true },
  instagramVideo: { type: String, required: true },
  isVip: { type: Boolean, default: false },
  sequencePosition: { type: Number, required: true }, // 0-3 (VIP), 4-13 (Regular)
  views: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  packageId: { type: String, default: null },
  engagementTarget: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});
const IGActiveSlot = mongoose.models.IGActiveSlot || mongoose.model("IGActiveSlot", IGActiveSlotSchema);

// Schema tracking users holding in the queue matrix waiting list
const IGWaitingQueueSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  instagramChannel: { type: String, required: true },
  instagramVideo: { type: String, required: true },
  appealCount: { type: Number, default: 0 },
  appealedBy: { type: [String], default: [] },
  timestamp: { type: Date, default: Date.now }
});
const IGWaitingQueue = mongoose.models.IGWaitingQueue || mongoose.model("IGWaitingQueue", IGWaitingQueueSchema);

// Schema tracking personal tracking variables (user metadata progression)
const IGUserProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  acceptedConditions: { type: Boolean, default: false },
  visitedChannels: { type: [String], default: [] },
  activeSequenceIndex: { type: Number, default: 0 },
  cooldownUntil: { type: Date, default: null },
  appealBanUntil: { type: Date, default: null }
});
const IGUserProfile = mongoose.models.IGUserProfile || mongoose.model("IGUserProfile", IGUserProfileSchema);

// Schema tracking VIP orders queued when all 4 Instagram VIP slots are occupied
const IGVIPQueueSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  packageId: { type: String, required: true },
  targetLink: { type: String, required: true },
  engagementTarget: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});
const IGVIPQueue = mongoose.models.IGVIPQueue || mongoose.model("IGVIPQueue", IGVIPQueueSchema);


/* ---------------- UTILITY HELPER FUNCTIONS ---------------- */

function sanitizeInstagramUrl(url) {
  if (!url) return "";
  try {
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.delete("si");
    parsedUrl.searchParams.delete("t");
    return parsedUrl.toString();
  } catch (e) {
    return url.split(/[?#]/)[0];
  }
}

async function getOrCreateSystemState() {
  let state = await IGBoardState.findOne();
  if (!state) {
    state = new IGBoardState({
      appealingPeriodActive: false,
      activeSequenceIndex: 0
    });
    await state.save();
  }
  return state;
}

async function processAppealingPeriodEnd() {
  console.log("=== [IG] processAppealingPeriodEnd STARTED ===");

  try {
    const activeSlots = await IGActiveSlot.find().sort({ sequencePosition: 1 });
    let waitingUsers = await IGWaitingQueue.find().sort({ timestamp: 1 });

    const rejectedUsers = waitingUsers.filter(u => u.appealCount >= 3);

    for (const rejected of rejectedUsers) {
      await IGUserProfile.findOneAndUpdate(
        { userId: rejected.userId },
        {
          appealBanUntil: new Date(Date.now() + (4 * 60 * 60 * 1000)),
          acceptedConditions: false,
          visitedChannels: []
        },
        { upsert: true }
      );
      await IGWaitingQueue.deleteOne({ _id: rejected._id });
    }

    waitingUsers = await IGWaitingQueue.find().sort({ timestamp: 1 });

    const promotedUsers = waitingUsers.slice(0, 10);
    const regularActiveSlots = activeSlots.filter(s => s.sequencePosition >= 4);

    for (const slot of regularActiveSlots) {
      await IGUserProfile.findOneAndUpdate(
        { userId: slot.userId },
        {
          cooldownUntil: new Date(Date.now() + (3 * 60 * 60 * 1000)),
          acceptedConditions: false,
          visitedChannels: []
        },
        { upsert: true }
      );
      await IGActiveSlot.deleteOne({ _id: slot._id });
    }

    for (let i = 0; i < promotedUsers.length; i++) {
      const user = promotedUsers[i];
      const targetPos = 4 + i;

      await IGActiveSlot.create({
        userId: user.userId,
        username: user.username,
        instagramChannel: user.instagramChannel,
        instagramVideo: user.instagramVideo,
        sequencePosition: targetPos,
        isVip: false
      });

      await IGWaitingQueue.deleteOne({ _id: user._id });
    }

    await IGActiveSlot.updateMany(
      { sequencePosition: { $gte: 4 } },
      { $set: { views: 0, followers: 0, likes: 0, comments: 0 } }
    );
    await IGUserProfile.updateMany(
      {},
      { $set: { visitedChannels: [], activeSequenceIndex: 0 } }
    );
    console.log("=== [IG] processAppealingPeriodEnd FINISHED ===");

  } catch (err) {
    console.error("[IG] processAppealingPeriodEnd ERROR:", err);
    throw err;
  }
}


/* ---------------- ROUTER ROUTE CHANNELS API ---------------- */

/**
 * GET /api/instagram-dashboard/state
 */
router.get("/api/instagram-dashboard/state", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.model("User");

    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    if (!dbUser) return res.status(404).json({ error: "Profile node missing." });

    const userId = dbUser._id.toString();

    let userProfile = await IGUserProfile.findOne({ userId });
    if (!userProfile) {
      userProfile = new IGUserProfile({ userId });
      await userProfile.save();
    }

    const sysState = await getOrCreateSystemState();

    let appealingPeriod = { isActive: false, countdownText: "00:00", phase: 0 };
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const now = Date.now();
      const end = new Date(sysState.appealingPeriodEnd).getTime();
      const remainingMs = end - now;

      if (remainingMs <= 0) {
        if (sysState.activeSequenceIndex === 999) {
          sysState.activeSequenceIndex = 0;
          sysState.appealingPeriodEnd = new Date(Date.now() + 10 * 60000);
          await sysState.save();
        } else {
          const lockedState = await IGBoardState.findOneAndUpdate(
            { _id: sysState._id, appealingPeriodActive: true },
            { $set: { appealingPeriodActive: false, appealingPeriodEnd: null } },
            { new: false }
          );

          if (lockedState && lockedState.appealingPeriodActive === true) {
            console.log("[IG] SUCCESS: This instance won the lock. Processing cleanup...");
            await processAppealingPeriodEnd();
          } else {
            console.log("[IG] BLOCKED: Cleanup already handled by another concurrent request.");
          }
        }
      } else {
        appealingPeriod.isActive = true;
        const totalSecs = Math.floor(remainingMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        appealingPeriod.countdownText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        appealingPeriod.remainingSeconds = totalSecs;

        if (sysState.activeSequenceIndex === 999) {
          appealingPeriod.phase = 0;
        } else if (totalSecs > 240) {
          appealingPeriod.phase = 1;
        } else {
          appealingPeriod.phase = 2;
        }
      }
    }

    const activeSlots = await IGActiveSlot.find().sort({ sequencePosition: 1 });
    const myQueueRecord = await IGWaitingQueue.findOne({ userId });

    let vipChannels = [];
    let regularChannels = [];

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

    const realActiveCount = activeSlots.length;
    const userIsActiveOnBoard = activeSlots.some(s => s.userId.toString() === userId.toString());

    const vipSlots = activeSlots.filter(s => s.sequencePosition < 4);
    const regularSlots = activeSlots.filter(s => s.sequencePosition >= 4);

    let startIndex = 0;
    if (vipSlots.length > 0) {
      startIndex = vipSlots.sort((a, b) => a.sequencePosition - b.sequencePosition)[0].sequencePosition;
    } else if (regularSlots.length > 0) {
      startIndex = regularSlots.sort((a, b) => a.sequencePosition - b.sequencePosition)[0].sequencePosition;
    }

    const isActiveOnBoard = await IGActiveSlot.exists({ userId });
    const isInWaitingList = await IGWaitingQueue.exists({ userId });

    let buttonSystemState = {
      disabled: false,
      activeSequenceIndex: userProfile.activeSequenceIndex || startIndex
    };

    if (isActiveOnBoard || isInWaitingList) {
      buttonSystemState.disabled = true;
      buttonSystemState.lockReason = "SYSTEM_MEMBER_NO_VISIT";
    }

    if (appealingPeriod.isActive) {
      if (appealingPeriod.phase === 2) {
        const hasTargetedVisitsLeft = [...vipChannels, ...regularChannels].some(c => c.canVisitTargeted === true);
        buttonSystemState.disabled = !hasTargetedVisitsLeft;
      } else {
        buttonSystemState.disabled = true;
      }
    }

    const rawQueue = await IGWaitingQueue.find().sort({ timestamp: 1 });
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
            instagramVideo: activeMatch.instagramVideo,
            canVisitTargeted: canVisit
          });
        }
      }
      waitingListUsers.push({
        id: q._id.toString(),
        userId: q.userId,
        username: q.username,
        instagramChannel: q.instagramChannel,
        appealCount: q.appealCount,
        appealedBy: q.appealedBy,
        canBeAppealedByMe: appealingPeriod.phase === 1 && !q.appealedBy.includes(userId) && q.userId !== userId,
        accusers: accusersDetails
      });
    }

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
      userAccount: { username: dbUser.username, channelUrl: dbUser.instagram_link || "https://instagram.com/channel_placeholder" },
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
    console.error("[IG] STATE ROUTE ERROR:", err);
    res.status(500).json({
      error: "State compilation failure",
      details: err.message
    });
  }
});

/**
 * POST /api/instagram-dashboard/accept-conditions
 */
router.post("/api/instagram-dashboard/accept-conditions", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    if (!dbUser) return res.status(404).json({ error: "User identity unverified" });

    await IGUserProfile.findOneAndUpdate(
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
 * POST /api/instagram-dashboard/verify-visit
 */
router.post("/api/instagram-dashboard/verify-visit", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const { elementId, sequencePosition } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const userId = dbUser._id.toString();

    const userProfileCheck = await IGUserProfile.findOne({ userId });
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
    const slot = await IGActiveSlot.findById(elementId);
    if (!slot) return res.status(404).json({ error: "Target node profile shifted or expired." });

    let isPhase2Visit = false;
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const remainingMs = new Date(sysState.appealingPeriodEnd).getTime() - Date.now();
      const totalSecs = Math.floor(remainingMs / 1000);
      if (totalSecs <= 240 && totalSecs > 0 && sysState.activeSequenceIndex !== 999) {
        isPhase2Visit = true;
      }
    }

    const isActiveOnBoard = await IGActiveSlot.findOne({ userId });
    const myQueueRecord = await IGWaitingQueue.findOne({ userId });

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

    const hasAlreadyVisited = userProfileCheck && userProfileCheck.visitedChannels.includes(elementId);
    let currentSlotData = slot;

    if (!isPhase2Visit && !hasAlreadyVisited) {
      currentSlotData = await IGActiveSlot.findByIdAndUpdate(
        elementId,
        { $inc: { views: 1, followers: 1, likes: 1, comments: 1 } },
        { new: true }
      );
    }

    // VIP auto-clear: slot reached its purchased engagement target + 100 bonus
    if (!isPhase2Visit && !hasAlreadyVisited && currentSlotData && currentSlotData.isVip && currentSlotData.engagementTarget > 0) {
      if (currentSlotData.views >= currentSlotData.engagementTarget + 100) {
        const freedPosition = currentSlotData.sequencePosition;
        await IGActiveSlot.deleteOne({ _id: currentSlotData._id });
        // Promote next queued VIP order into the freed position
        const nextVip = await IGVIPQueue.findOne().sort({ createdAt: 1 });
        if (nextVip) {
          await IGActiveSlot.create({
            userId: nextVip.userId,
            username: nextVip.username,
            instagramChannel: nextVip.targetLink,
            instagramVideo: nextVip.targetLink,
            isVip: true,
            sequencePosition: freedPosition,
            packageId: nextVip.packageId,
            engagementTarget: nextVip.engagementTarget,
            views: 0, followers: 0, likes: 0, comments: 0
          });
          await IGVIPQueue.deleteOne({ _id: nextVip._id });
        }
        return res.json({ success: true, systemAlertMessage: null });
      }
    }

    let profileUpdates = {
      ...(isPhase2Visit ? {} : { $addToSet: { visitedChannels: elementId } }),
      $set: {
        lastVisitElementId: elementId,
        lastVisitAt: nowTime
      }
    };

    if (isPhase2Visit) {
      await IGUserProfile.findOneAndUpdate({ userId }, profileUpdates, { upsert: true });
      return res.json({ success: true });
    }

    const activeSlots = await IGActiveSlot.find().sort({ sequencePosition: 1 });

    const slotIndex = activeSlots.findIndex(s => s._id.toString() === elementId);
    if (slotIndex !== -1) {
      activeSlots[slotIndex] = currentSlotData;
    }

    let nextIndex = sequencePosition + 1;
    let lookupsAttempted = 0;

    while (lookupsAttempted < 14) {
      if (nextIndex >= 14) nextIndex = 0;

      const checkNext = activeSlots.find(s => s.sequencePosition === nextIndex);
      if (checkNext) {
        profileUpdates.$set.activeSequenceIndex = nextIndex;
        break;
      }
      nextIndex++;
      lookupsAttempted++;
    }

    let responsePayload = { success: true, systemAlertMessage: null };

    const allUsersReachedTen = activeSlots.length >= 10 &&
      activeSlots.every(slot =>
        slot.views >= 10 &&
        slot.followers >= 10 &&
        slot.likes >= 10 &&
        slot.comments >= 10
      );

    if (allUsersReachedTen) {
      sysState.appealingPeriodActive = true;
      sysState.appealingPeriodEnd = new Date(Date.now() + 1 * 60000);
      sysState.activeSequenceIndex = 999;

      const resetIndex = activeSlots.length > 0 ? activeSlots[0].sequencePosition : 0;
      profileUpdates.$set.activeSequenceIndex = resetIndex;

      responsePayload.systemAlertMessage = "txtUploadFormFrozen";
    }

    await IGUserProfile.findOneAndUpdate({ userId }, profileUpdates, { upsert: true });
    await sysState.save();

    res.json(responsePayload);

  } catch (err) {
    console.error("[IG]", err);
    res.status(500).json({ error: "Visit verification process crash" });
  }
});

/**
 * POST /api/instagram-dashboard/submit-promotion
 */
router.post("/api/instagram-dashboard/submit-promotion", auth, async (req, res) => {
  try {
    await connectToDatabase();
    let { rawVideoUrl, rawChannelUrl } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const userId = dbUser._id.toString();
    const userProfile = await IGUserProfile.findOne({ userId });

    const alreadyExists = await IGActiveSlot.findOne({ userId });
    if (alreadyExists) {
      return res.status(400).json({ errorKey: "txtSingleUploadSecurity" });
    }

    if (userProfile?.appealBanUntil && userProfile.appealBanUntil > new Date()) {
      return res.status(403).json({ error: "Appeal lockdown active" });
    }

    if (userProfile?.cooldownUntil && userProfile.cooldownUntil > new Date()) {
      return res.status(403).json({ error: "Cooldown active" });
    }

    const cleanVideoUrl = sanitizeInstagramUrl(rawVideoUrl);
    const cleanChannelUrl = sanitizeInstagramUrl(rawChannelUrl);

    if (!cleanVideoUrl.includes("instagram.com")) {
      return res.status(400).json({ errorKey: "validationErrorLink" });
    }

    if (dbUser.instagram_link && sanitizeInstagramUrl(dbUser.instagram_link) !== cleanChannelUrl) {
      return res.status(400).json({ errorKey: "securityErrorProfile" });
    }

    let targetPosition = -1;

    for (let i = 4; i < 14; i++) {
      const exists = await IGActiveSlot.findOne({ sequencePosition: i });

      if (!exists) {
        targetPosition = i;

        await IGActiveSlot.create({
          userId,
          username: dbUser.username,
          instagramChannel: cleanChannelUrl,
          instagramVideo: cleanVideoUrl,
          sequencePosition: i,
          isVip: false
        });

        break;
      }
    }

    if (targetPosition === -1) {
      const inQueue = await IGWaitingQueue.findOne({ userId });
      if (!inQueue) {
        const newQueueNode = new IGWaitingQueue({
          userId,
          username: dbUser.username,
          instagramChannel: cleanChannelUrl,
          instagramVideo: cleanVideoUrl
        });
        await newQueueNode.save();
      }
      return res.json({ successKey: "txtSingleUploadSecurity" });
    }

    await IGUserProfile.findOneAndUpdate(
      { userId },
      {
        visitedChannels: [],
        activeSequenceIndex: 0
      }
    );

    return res.json({ successKey: "txtPromoZoneUnlocked" });
  } catch (err) {
    console.error("[IG]", err);
    res.status(500).json({ error: "Promotion submission cycle break" });
  }
});

/**
 * POST /api/instagram-dashboard/appeal-user
 */
router.post("/api/instagram-dashboard/appeal-user", auth, async (req, res) => {
  try {
    await connectToDatabase();
    const { queueUserId } = req.body;
    const User = mongoose.model("User");
    const lookupUsername = typeof req.user === "object" ? req.user.username : req.user;
    const dbUser = await User.findOne({ username: lookupUsername });
    const currentOperatorId = dbUser._id.toString();

    const isActiveUser = await IGActiveSlot.findOne({ userId: currentOperatorId });
    if (!isActiveUser) {
      return res.status(403).json({ error: "Only active users can submit appeals." });
    }

    const myAppealsCount = await IGWaitingQueue.countDocuments({
      appealedBy: currentOperatorId
    });

    if (myAppealsCount >= 3) {
      return res.status(400).json({ error: "You have already used all 3 appeals." });
    }

    const sysState = await getOrCreateSystemState();
    if (sysState.appealingPeriodActive && sysState.appealingPeriodEnd) {
      const remainingMs = new Date(sysState.appealingPeriodEnd).getTime() - Date.now();
      if (Math.floor(remainingMs / 1000) <= 240) {
        return res.status(400).json({ error: "Appealing phase window has closed. Verification window active." });
      }
    } else {
      return res.status(400).json({ error: "Appealing process is not active." });
    }

    const queueRecord = await IGWaitingQueue.findById(queueUserId);
    if (!queueRecord) return res.status(404).json({ error: "Queue element targeted not found." });

    if (queueRecord.appealedBy.includes(currentOperatorId)) {
      return res.status(400).json({ error: "Operator verification note already documented on this slot vector." });
    }

    queueRecord.appealCount += 1;
    queueRecord.appealedBy.push(currentOperatorId);
    await queueRecord.save();

    res.json({ success: true });

  } catch (err) {
    console.error("[IG]", err);
    res.status(500).json({ error: "Validation query system process fault" });
  }
});

module.exports = router;
