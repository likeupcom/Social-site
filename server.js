require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

/* ---------------- FIX SCRIPT BLOCKING (CSP) ---------------- */
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src * 'unsafe-inline'; img-src * data: blob:; style-src * 'unsafe-inline';",
  );
  next();
});

/* ---------------- MONGODB CONNECTION ---------------- */
if (!process.env.MONGODB_URI) {
  console.error("ERROR: MONGODB_URI missing!");
  process.exit(1);
}

// Added tlsAllowInvalidCertificates to bypass the Hugging Face certificate validation error
mongoose
  .connect(process.env.MONGODB_URI, {
    tlsAllowInvalidCertificates: true
  })
  .then(() => console.log("✅ Database connected successfully"))
  .catch((err) => {
    console.error("❌ Database connection failed:", err.message);
    console.log("⚠️ Application running in degraded state. Check MongoDB credentials.");
  });

/* ---------------- USER MODEL ---------------- */
// ✅ ONLY UPDATE: Added the tiktokProfile property safely while keeping your exact youtubeChannel property untouched
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  youtubeChannel: { type: String, default: "" },
  tiktokProfile: { type: String, default: "" }
});

const User = mongoose.model("User", userSchema);

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* Serve public pages */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- VALIDATION RULES ---------------- */
function isGmail(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email);
}

function isUsername(username) {
  return /^[a-zA-Z0-9]+$/.test(username);
}

function isPassword(password) {
  return /^[0-9]+$/.test(password);
}

/* ---------------- HELPER TO CREATE COOKIE ---------------- */
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

/* ---------------- SIGNUP ROUTE ---------------- */
app.post("/signup", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.send("Fill all fields.");
    }

    if (!isGmail(email) || !isUsername(username) || !isPassword(password)) {
      return res.send("Invalid signup format rules.");
    }

    if (mongoose.connection.readyState !== 1) {
      return res.send("Database connection is offline. Cannot save user.");
    }

    const usernameExists = await User.findOne({ username });
    if (usernameExists) {
      return res.send("Username already exists.");
    }

    const emailExists = await User.findOne({ email });
    if (emailExists) {
      return res.send("Email already registered.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      email,
      username,
      password: hashedPassword,
    });

    // Log user in automatically with browser token
    const token = sendTokenCookie(res, username);
    
    // Redirect home passing the token as a query parameter for iframe support
    res.redirect(`/index.html?auth_token=${token}`);

  } catch (error) {
    console.error(error);
    res.send("Signup error.");
  }
});

/* ---------------- LOGIN ROUTE ---------------- */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.send("Fill all fields.");
    }

    if (!isUsername(username) || !isPassword(password)) {
      return res.send("Invalid login format rules.");
    }

    if (mongoose.connection.readyState !== 1) {
      return res.send("Database connection offline.");
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.send("Incorrect username or password.");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.send("Incorrect username or password.");
    }

    // Log user in with browser token
    const token = sendTokenCookie(res, username);
    
    // Redirect home passing the token as a query parameter for iframe support
    res.redirect(`/index.html?auth_token=${token}`);

  } catch (error) {
    console.error(error);
    res.send("Login error.");
  }
});

/* ---------------- LOGIN CHECK API ---------------- */
app.get("/me", (req, res) => {
  // Checks for token inside cookies first, then falls back to URL token query parameter
  const token = req.cookies.token || req.query.token;
  if (!token) return res.json({ user: null, token: null });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded.user, token: token });
  } catch (err) {
    res.json({ user: null, token: null });
  }
});

/* ---------------- LOGOUT ---------------- */
app.get("/logout", (req, res) => {
  res.clearCookie("token", { secure: true, sameSite: "none" });
  res.redirect("/login.html");
});


/* ---------------- ORIGINAL YOUTUBE PROFILE ENDPOINTS (UNTOUCHED) ---------------- */

// 🟢 GET: Loads user's channel handle link configuration on application load
app.get("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.user });
    if (!user) return res.status(404).json({ error: "User context not found." });

    res.json({ youtubeChannel: user.youtubeChannel || "" });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});

// 🔵 POST: Saves input data handle securely while intercepting system wide duplicate channels
app.post("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { youtubeChannel } = req.body;

    if (!youtubeChannel) return res.status(400).json({ error: "Required channel link parameters are missing." });

    // Enforce systemic uniqueness checks across the entire cluster
    const linkExists = await User.findOne({ youtubeChannel: youtubeChannel, username: { $ne: decoded.user } });
    if (linkExists) {
      return res.status(409).json({ isDuplicate: true, error: "Channel already exists!" });
    }

    await User.findOneAndUpdate({ username: decoded.user }, { youtubeChannel: youtubeChannel });
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});

// 🔴 DELETE: Wipes out profile entry tracking when users switch channel handles
app.delete("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    await User.findOneAndUpdate({ username: decoded.user }, { youtubeChannel: "" });
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});


/* ---------------- NEW SEPARATE ENDPOINT FOR TIKTOK ONLY ---------------- */

// 🟢 GET: Loads user's TikTok handle from MongoDB
app.get("/api/user/tiktok", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.user });
    if (!user) return res.status(404).json({ error: "User not found." });

    res.json({ tiktok_link: user.tiktokProfile || "" });
  } catch (err) {
    res.status(401).json({ error: "Session expired." });
  }
});

// 🔵 POST: Saves TikTok handle safely
app.post("/api/user/tiktok", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { tiktok_link } = req.body;

    if (!tiktok_link) return res.status(400).json({ error: "Missing parameter." });

    const linkExists = await User.findOne({ tiktokProfile: tiktok_link, username: { $ne: decoded.user } });
    if (linkExists) {
      return res.status(409).json({ isDuplicate: true, error: "TikTok link already exists!" });
    }

    await User.findOneAndUpdate({ username: decoded.user }, { tiktokProfile: tiktok_link });
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session expired." });
  }
});


/* ---------------- AUTH MIDDLEWARE (COMPLETED) ---------------- */
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token;
  if (!token) {
    return res.redirect("/login.html");
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user;
    next();
  } catch (err) {
    res.redirect("/login.html");
  }
}

/* ---------------- START APPLICATION SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is listening securely on port ${PORT}`);
});
