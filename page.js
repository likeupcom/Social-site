// page.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

// Helper Auth Middleware
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.redirect("/login.html");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user; // This contains the unique username used during signup
    next();
  } catch (err) {
    res.redirect("/login.html");
  }
}

// Helper utility to automatically strip tracking parameters from submitted links
function cleanYoutubeUrl(urlStr) {
  if (!urlStr) return "";
  try {
    const url = new URL(urlStr);
    url.searchParams.delete("si");
    url.searchParams.delete("feature");
    url.searchParams.delete("sub_confirmation");
    return url.toString();
  } catch (e) {
    // Fallback split if standard parsing runs into edge strings
    return urlStr.split("?")[0];
  }
}

/* ---------------- DATABASE SCHEMA CONFIGURATIONS ---------------- */
let PlatformState;
try {
  PlatformState = mongoose.model("PlatformState");
} catch (e) {
  const PlatformStateSchema = new mongoose.Schema({
    systemPhase: { type: String, default: "REGULAR_PERIOD" }, // REGULAR_PERIOD or APPEAL_PERIOD
    appealEndTime: { type: Date, default: null },
    globalMetrics: {
      totalViews: { type: Number, default: 0 },
      totalSubs: { type: Number, default: 0 },
      totalLikes: { type: Number, default: 0 },
      totalComments: { type: Number, default: 0 }
    },
    vipBoard: [{
      isEmptySlot: { type: Boolean, default: true },
      username: { type: String, default: "" },
      channelLink: { type: String, default: "" },
      youtubeLink: { type: String, default: "" }, // Video Link
      clicks: { type: Number, default: 0 }
    }],
    activeBoard: [{
      isEmptySlot: { type: Boolean, default: true },
      username: { type: String, default: "" },
      channelLink: { type: String, default: "" },
      youtubeLink: { type: String, default: "" }, // Video Link
      clicks: { type: Number, default: 0 }
    }],
    waitingList: [{
      username: { type: String, required: true },
      channelLink: { type: String, required: true },
      youtubeLink: { type: String, required: true },
      appealsCount: { type: Number, default: 0 },
      voters: [{ type: String }]
    }],
    lockdowns: [{
      username: { type: String, required: true },
      until: { type: Date, required: true }
    }]
  });
  PlatformState = mongoose.model("PlatformState", PlatformStateSchema);
}

// Function to guarantee the state engine has all matching positions initialized
async function getOrCreateState() {
  let state = await PlatformState.findOne();
  if (!state) {
    state = new PlatformState({
      vipBoard: Array(4).fill(null).map(() => ({ isEmptySlot: true, username: "", channelLink: "", youtubeLink: "", clicks: 0 })),
      activeBoard: Array(10).fill(null).map(() => ({ isEmptySlot: true, username: "", channelLink: "", youtubeLink: "", clicks: 0 })),
      waitingList: []
    });
    await state.save();
  }
  return state;
}

/* ---------------- CORE ENGINE ROUTING ACTIONS ---------------- */

// 1. Fetch live matrix updates, manage state resets, and process the 2-minute appeal end triggers
router.get("/api/state/sync-youtube", auth, async (req, res) => {
  try {
    const state = await getOrCreateState();
    const now = new Date();

    // Check if the 2-minute Appeal Period countdown has reached 0
    if (state.systemPhase === "APPEAL_PERIOD" && state.appealEndTime && now >= state.appealEndTime) {
      state.systemPhase = "REGULAR_PERIOD";
      state.appealEndTime = null;

      // Drop all current 10 live board users into a strict 3-hour lockout window
      state.activeBoard.forEach(slot => {
        if (!slot.isEmptySlot) {
          state.lockdowns.push({ username: slot.username, until: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        }
      });

      // Shift the first 10 remaining profiles in the waiting list onto the live board
      const nextTen = state.waitingList.slice(0, 10);
      state.waitingList = state.waitingList.slice(nextTen.length);

      for (let i = 0; i < 10; i++) {
        if (nextTen[i]) {
          state.activeBoard[i] = {
            isEmptySlot: false,
            username: nextTen[i].username,
            channelLink: nextTen[i].channelLink,
            youtubeLink: nextTen[i].youtubeLink,
            clicks: 0
          };
        } else {
          // Backfill Fallback Rule: Pull random inactive profiles from the core User registration base
          try {
            const User = mongoose.model("User");
            const usedUsernames = state.activeBoard.map(s => s.username).filter(Boolean);
            
            const randomUsers = await User.aggregate([
              { $match: { username: { $nin: usedUsernames } } },
              { $sample: { size: 1 } }
            ]);

            if (randomUsers && randomUsers[0]) {
              state.activeBoard[i] = {
                isEmptySlot: false,
                username: randomUsers[0].username,
                channelLink: randomUsers[0].youtubeChannel || "https://youtube.com", // Linked to schema structure
                youtubeLink: "https://youtube.com",
                clicks: 0
              };
            } else {
              state.activeBoard[i] = { isEmptySlot: true, username: "", channelLink: "", youtubeLink: "", clicks: 0 };
            }
          } catch (err) {
            state.activeBoard[i] = { isEmptySlot: true, username: "", channelLink: "", youtubeLink: "", clicks: 0 };
          }
        }
      }
      await state.save();
    }

    // Automatically filter out expired user lockouts
    state.lockdowns = state.lockdowns.filter(l => l.until > now);
    await state.save();

    // Verify current user status parameters
    const userLock = state.lockdowns.find(l => l.username === req.user);
    const isLockedOut = !!userLock;
    const lockTimeRemaining = isLockedOut ? Math.ceil((userLock.until - now) / 60000) : 0;

    const isBoardFull = state.activeBoard.every(slot => !slot.isEmptySlot);

    res.json({
      systemPhase: state.systemPhase,
      appealTimeRemaining: state.appealEndTime ? Math.ceil((state.appealEndTime - now) / 1000) : 0,
      vipBoard: state.vipBoard,
      activeBoard: state.activeBoard,
      waitingList: state.waitingList,
      globalMetrics: state.globalMetrics,
      isBoardFull: isBoardFull,
      userLockout: { isLockedOut, lockTimeRemaining }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to read system telemetry channels." });
  }
});

// 2. Telemetry validation route: Increments clicks + metrics (+1 all) and transitions to Appeal Phase if rules match
router.post("/api/action/visit-complete", auth, async (req, res) => {
  try {
    const { boardType, targetIndex } = req.body;
    const state = await getOrCreateState();

    if (state.systemPhase === "APPEAL_PERIOD") {
      return res.status(400).json({ error: "System interaction frozen inside the 2-minute Appeal Period window." });
    }

    let targetSlot = boardType === "vip" ? state.vipBoard[targetIndex] : state.activeBoard[targetIndex];
    if (!targetSlot || targetSlot.isEmptySlot) {
      return res.status(400).json({ error: "Target position is vacant." });
    }

    // Process incrementations
    targetSlot.clicks += 1;
    state.globalMetrics.totalViews += 1;
    state.globalMetrics.totalSubs += 1;
    state.globalMetrics.totalLikes += 1;
    state.globalMetrics.totalComments += 1;

    // Trigger Appeal Period condition: Activated the exact moment every regular slot hits at least 10 clicks
    const allRegularSlotsFull = state.activeBoard.every(slot => !slot.isEmptySlot);
    const allRegularSlotsHitTen = state.activeBoard.every(slot => slot.isEmptySlot || slot.clicks >= 10);

    if (allRegularSlotsFull && allRegularSlotsHitTen) {
      state.systemPhase = "APPEAL_PERIOD";
      state.appealEndTime = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
    }

    await state.save();
    res.json({ message: "Metrics log processed cleanly.", systemPhase: state.systemPhase });
  } catch (error) {
    res.status(500).json({ error: "Database interaction logging error." });
  }
});

// 3. Process Appeal button vouchers during the 2-minute phase (Removes queue targets when hitting 3 votes)
router.post("/api/action/appeal", auth, async (req, res) => {
  try {
    const { targetUsername } = req.body;
    const state = await getOrCreateState();

    if (state.systemPhase !== "APPEAL_PERIOD") {
      return res.status(400).json({ error: "Appeals are only open during the 2-minute appeal countdown phase." });
    }

    const queueIndex = state.waitingList.findIndex(item => item.username === targetUsername);
    if (queueIndex === -1) {
      return res.status(404).json({ error: "User profile target not located inside the current waiting list." });
    }

    if (state.waitingList[queueIndex].voters.includes(req.user)) {
      return res.status(400).json({ error: "You can only cast an appeal vote on an account profile once per window." });
    }

    state.waitingList[queueIndex].voters.push(req.user);
    state.waitingList[queueIndex].appealsCount += 1;

    // If an account gets exactly 3 appeals, eliminate them immediately from the waiting list queue
    if (state.waitingList[queueIndex].appealsCount >= 3) {
      state.waitingList.splice(queueIndex, 1);
    }

    await state.save();
    res.json({ message: "Appeal vote verified successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to record your verification check request." });
  }
});

// 4. Secure submission gate: Verifies input channel matching database records, strips trackers, and updates queue grids
router.post("/api/submit-link", auth, async (req, res) => {
  try {
    const { channelLink, youtubeLink } = req.body;
    const state = await getOrCreateState();

    const now = new Date();
    const userLock = state.lockdowns.find(l => l.username === req.user && l.until > now);
    if (userLock) {
      return res.status(403).json({ error: `Your submission profile is locked out. Try again in ${Math.ceil((userLock.until - now) / 60000)} minutes.` });
    }

    // Access primary registration document models to cross-verify channel link history
    const User = mongoose.model("User");
    const existingUserDoc = await User.findOne({ username: req.user });

    // ✅ FIXED BUG HERE: Changed existingUserDoc.channelLink to existingUserDoc.youtubeChannel to match your Mongoose Schema
    if (!existingUserDoc || !existingUserDoc.youtubeChannel) {
      return res.status(400).json({ error: "No profile channel link registered in database. Please upload it via youtube.html first." });
    }

    const cleanInputChannel = cleanYoutubeUrl(channelLink);
    // ✅ FIXED BUG HERE: Changed existingUserDoc.channelLink to existingUserDoc.youtubeChannel to match your Mongoose Schema
    const cleanDbChannel = cleanYoutubeUrl(existingUserDoc.youtubeChannel);

    // Cross-verify matching criteria requirements
    if (cleanInputChannel !== cleanDbChannel) {
      return res.status(400).json({ error: "Provided channel link does not match your previously uploaded channel profile record." });
    }

    const cleanVideoLink = cleanYoutubeUrl(youtubeLink);

    // Phase 1 (First 10 Users): If the live board isn't completely filled yet, directly populate an open slot
    const openRegularIndex = state.activeBoard.findIndex(slot => slot.isEmptySlot);
    if (openRegularIndex !== -1) {
      state.activeBoard[openRegularIndex] = {
        isEmptySlot: false,
        username: req.user,
        channelLink: cleanInputChannel,
        youtubeLink: cleanVideoLink,
        clicks: 0
      };
      await state.save();
      return res.json({ message: "Success! Your video was deployed onto an open active slot location instantly." });
    }

    // Phase 2: Matrix is full, dump into the waiting list queue array
    state.waitingList.push({
      username: req.user,
      channelLink: cleanInputChannel,
      youtubeLink: cleanVideoLink,
      appealsCount: 0,
      voters: []
    });

    await state.save();
    res.json({ message: "Sequence verified successfully. You have been positioned on the Waiting List." });
  } catch (error) {
    res.status(500).json({ error: "Submission verification loop dropped due to system exception rules." });
  }
});

module.exports = router;
