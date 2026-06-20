require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

const app = express();
const PORT = 7860;
const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

/* ---------------- 1. SECURITY & MIDDLEWARE ---------------- */

// Content Security Policy (CSP) Fix
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

/* ---------------- 2. DATABASE CONNECTION ---------------- */
if (!process.env.MONGODB_URI) {
  console.error("❌ ERROR: MONGODB_URI missing from environment variables!");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI, {
    tlsAllowInvalidCertificates: true // Bypasses Hugging Face/self-signed cert validation issues
  })
  .then(() => console.log("✅ Database connected successfully"))
  .catch((err) => {
    console.error("❌ Database connection failed:", err.message);
    console.log("⚠️ Application running in degraded state. Check MongoDB credentials.");
  });

/* ---------------- 3. DATABASE SCHEMA & MODEL ---------------- */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  youtubeChannel: { type: String, default: "" },
  tiktok_link: { type: String, default: "" },
  instagram_link: { type: String, default: "" },
  facebook_link: { type: String, default: "" }
});

const User = mongoose.model("User", userSchema);

/* ---------------- 4. UTILITY & VALIDATION FUNCTIONS ---------------- */
const isGmail = (email) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email);
const isUsername = (username) => /^[a-zA-Z0-9]+$/.test(username);
const isPasswordValid = (password) => password && password.length >= 6; // Refactored from digits-only to min 6 chars

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

/* ---------------- 5. AUTHENTICATION MIDDLEWARE ---------------- */
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
  if (!token) return res.redirect("/login.html");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    res.redirect("/login.html");
  }
}

/* ---------------- 6. AUTHENTICATION ROUTES ---------------- */

// SIGNUP
app.post("/signup", async (req, res) => {
  try {
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
    const { username, password } = req.body;

    if (!username || !password) return res.status(400).json({ error: "Fill all fields." });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: "Database offline." });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: "Incorrect username or password." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect username or password." });

    const token = sendTokenCookie(res, username);
    return res.redirect(`/index.html?auth_token=${token}`);
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Internal login error." });
  }
});

// CHECK SESSION
app.get("/me", (req, res) => {
  const token = req.cookies.token || req.query.token;
  if (!token) return res.json({ user: null, token: null });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({ user: decoded.user, token });
  } catch (err) {
    return res.json({ user: null, token: null });
  }
});

// LOGOUT
app.get("/logout", (req, res) => {
  res.clearCookie("token", { secure: true, sameSite: "none" });
  return res.redirect("/login.html");
});

/* ---------------- 7. PROFILE ENDPOINTS ---------------- */

// GET PROFILE LINKS
app.get("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
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

// POST UPDATE PROFILE LINKS (Optimized validation block)
app.post("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
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
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
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

/* ---------------- 8. ROUTING & PAGES ---------------- */

// External router fallback logic
const otherPagesRouter = require("./page.js");
app.use("/", otherPagesRouter);

// Dynamic HTML page router
app.get("/:page.html", auth, (req, res) => {
  const allowedPages = ["youtube", "tiktok", "instagram", "facebook"];
  const pageName = req.params.page;

  if (!allowedPages.includes(pageName)) {
    return res.status(404).send("Page not found.");
  }

  // Searches fallback paths sequentially
  const filePaths = [
    path.join(__dirname, "private", `${pageName}.html`),
    path.join(__dirname, `${pageName}.html`),
    path.join(__dirname, "public", `${pageName}.html`)
  ];

  for (const filePath of filePaths) {
    try {
      return res.sendFile(filePath);
    } catch {
      continue; // Skips to next path fallback if file doesn't exist
    }
  }

  return res.status(404).send(`Error: File ${pageName}.html cannot be located.`);
});

/* ---------------- 9. INITIALIZE SERVER ---------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server is listening securely on port ${PORT}`);
});
