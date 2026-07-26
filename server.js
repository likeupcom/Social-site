require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectToDatabase } = require("./lib/db");

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

/* ---------------- 1. SECURITY & MIDDLEWARE ---------------- */

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' *.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' *.com; connect-src 'self' *.com; img-src 'self' data: blob: *.com; style-src 'self' 'unsafe-inline' *.com;"
  );
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- 2. DATABASE SCHEMA & MODEL ---------------- */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  youtubeChannel: { type: String, default: "" },
  tiktok_link: { type: String, default: "" },
  instagram_link: { type: String, default: "" },
  facebook_link: { type: String, default: "" }
});

const User = mongoose.models.User || mongoose.model("User", userSchema);

/* ---------------- 3. UTILITY & VALIDATION FUNCTIONS ---------------- */
const isGmail = (email) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email);
const isUsername = (username) => /^[a-zA-Z0-9]+$/.test(username);
const isPasswordValid = (password) => password && password.length >= 6;

function sendTokenCookie(res, username) {
  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "24h" });
  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 24 * 60 * 60 * 1000
  });
  return token;
}

/* ---------------- 4. AUTHENTICATION MIDDLEWARE ---------------- */
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.redirect("/login.html");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes("json") || req.url.includes("/api/")) {
      return res.status(401).json({ error: "Unauthorized", sessionExpired: true });
    }
    res.redirect("/login.html");
  }
}

/* ---------------- 5. AUTHENTICATION ROUTES ---------------- */

// SIGNUP
app.post("/signup", async (req, res) => {
  try {
    await connectToDatabase();
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: "Fill all fields." });
    }
    if (!isGmail(email) || !isUsername(username) || !isPasswordValid(password)) {
      return res.status(400).json({ error: "Invalid signup format rules. Password must be at least 6 characters." });
    }
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: "Database connection is offline." });
    }

    const usernameExists = await User.findOne({ username });
    if (usernameExists) return res.status(409).json({ error: "Username already exists." });

    const emailExists = await User.findOne({ email });
    if (emailExists) return res.status(409).json({ error: "Email already registered." });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ email, username, password: hashedPassword });

    const token = sendTokenCookie(res, username);
    return res.redirect(`/index.html?auth_token=${token}`);
  } catch (error) {
    console.error("Signup Error:", error);
    return res.status(500).json({ error: "Internal signup error." });
  }
});

// LOGIN
app.post("/login", async (req, res) => {
  try {
    await connectToDatabase();
    const { username, password } = req.body;

    if (!username || !password) return res.status(400).json({ error: "Fill all fields." });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: "Database offline." });

    const cleanUsername = username.trim();
    const user = await User.findOne({ username: { $regex: new RegExp("^" + cleanUsername + "$", "i") } });

    if (!user) {
      console.log(`User not found in DB for input: "${cleanUsername}"`);
      return res.status(401).json({ error: "Incorrect username or password." });
    }

    const match = await bcrypt.compare(password.trim(), user.password);
    if (!match) {
      console.log(`Password mismatch for user: ${user.username}`);
      console.log(`Input password: ${password.trim()}`);
      console.log(`Stored hash in DB: ${user.password}`);
    }
    if (!match) return res.status(401).json({ error: "Incorrect username or password." });

    const token = sendTokenCookie(res, username);
    return res.redirect(`/index.html?auth_token=${token}`);
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Internal login error." });
  }
});

// CHECK SESSION
app.get("/me", async (req, res) => {
  try {
    await connectToDatabase();
    const token = req.cookies.token || req.query.token;
    if (!token) return res.json({ user: null, token: null });

    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({ user: decoded.user, token });
  } catch (err) {
    return res.json({ user: null, token: null });
  }
});

// LOGOUT
app.get("/logout", async (req, res) => {
  await connectToDatabase();
  res.clearCookie("token", { secure: true, sameSite: "none" });
  return res.redirect("/login.html");
});

/* ---------------- 6. PROFILE ENDPOINTS ---------------- */

// GET PROFILE LINKS
app.get("/api/user/profile", async (req, res) => {
  try {
    await connectToDatabase();
    const token = req.cookies.token || req.query.token || req.query.auth_token;
    if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.user });
    if (!user) return res.status(404).json({ error: "User not found." });

    return res.json({
      youtubeChannel: user.youtubeChannel || "",
      tiktok_link: user.tiktok_link || "",
      instagram_link: user.instagram_link || "",
      facebook_link: user.facebook_link || ""
    });
  } catch (err) {
    return res.status(401).json({ error: "Session token signature expired." });
  }
});

// POST UPDATE PROFILE LINKS
app.post("/api/user/profile", async (req, res) => {
  try {
    await connectToDatabase();
    const token = req.cookies.token || req.query.token || req.query.auth_token;
    if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

    const decoded = jwt.verify(token, JWT_SECRET);
    const incomingFields = req.body;

    const platforms = {
      youtubeChannel: "Channel link",
      tiktok_link: "TikTok link",
      instagram_link: "Instagram profile",
      facebook_link: "Facebook profile"
    };

    let updateData = {};

    for (const [key, label] of Object.entries(platforms)) {
      if (incomingFields[key] !== undefined) {
        if (incomingFields[key] !== "") {
          const duplicate = await User.findOne({ [key]: incomingFields[key], username: { $ne: decoded.user } });
          if (duplicate) return res.status(409).json({ isDuplicate: true, error: `${label} already exists!` });
        }
        updateData[key] = incomingFields[key];
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Required link parameters are missing." });
    }

    await User.findOneAndUpdate({ username: decoded.user }, updateData);
    return res.json({ success: true });
  } catch (err) {
    return res.status(401).json({ error: "Session token signature expired." });
  }
});

// DELETE INDIVIDUAL LINK
app.delete("/api/user/profile", async (req, res) => {
  try {
    await connectToDatabase();
    const token = req.cookies.token || req.query.token || req.query.auth_token;
    if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

    const decoded = jwt.verify(token, JWT_SECRET);
    const { platform } = req.query;

    let clearData = {};
    if (platform === "tiktok") clearData.tiktok_link = "";
    else if (platform === "instagram") clearData.instagram_link = "";
    else if (platform === "facebook") clearData.facebook_link = "";
    else clearData.youtubeChannel = "";

    await User.findOneAndUpdate({ username: decoded.user }, clearData);
    return res.json({ success: true });
  } catch (err) {
    return res.status(401).json({ error: "Session token signature expired." });
  }
});

/* ---------------- 7. ROUTING & PAGES ---------------- */

const tiktokDashboardRouter = require("./page1");
app.use(tiktokDashboardRouter);

const otherPagesRouter = require("./page.js");
app.use("/", otherPagesRouter);

const instagramDashboardRouter = require("./page2.js");
app.use(instagramDashboardRouter);

const facebookDashboardRouter = require("./page3.js");
app.use(facebookDashboardRouter);

app.get("/:page.html", auth, (req, res) => {
  const allowedPages = ["youtube", "tiktok", "instagram", "facebook"];
  const pageName = req.params.page;

  if (!allowedPages.includes(pageName)) {
    return res.status(404).send("Page not found.");
  }

  // Map short platform names to their actual dashboard file names
  const fileNameMap = {
    tiktok: "tiktok-improvement",
    youtube: "youtube",
    instagram: "instagram-improvement",
    facebook: "facebook-improvement"
  };
  const resolvedName = fileNameMap[pageName] || pageName;

  const filePaths = [
    path.join(__dirname, "private", `${resolvedName}.html`),
    path.join(__dirname, `${resolvedName}.html`),
    path.join(__dirname, "public", `${resolvedName}.html`)
  ];

  let index = 0;
  function tryNext() {
    if (index >= filePaths.length) {
      return res.status(404).send(`Error: File ${pageName}.html cannot be located.`);
    }
    res.sendFile(filePaths[index++], (err) => {
      if (err) tryNext();
    });
  }
  tryNext();
});

/* ---------------- 8. INITIALIZE SERVER ---------------- */
if (process.env.REPL_ID || process.env.PORT) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server active on Replit port ${PORT}`));
}

module.exports = app;
