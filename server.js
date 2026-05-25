require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const fs = require("fs"); 

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
// ✅ SAFELY EXTENDED SCHEMA: Added instagram_link and facebook_link alongside your active keys
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

    const token = sendTokenCookie(res, username);
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

    const token = sendTokenCookie(res, username);
    res.redirect(`/index.html?auth_token=${token}`);

  } catch (error) {
    console.error(error);
    res.send("Login error.");
  }
});

/* ---------------- LOGIN CHECK API ---------------- */
app.get("/me", (req, res) => {
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


/* ---------------- DYNAMIC ALL-IN-ONE PROFILE ENDPOINTS ---------------- */

// 🟢 GET: Loads user's channels links from MongoDB cluster
app.get("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.user });
    if (!user) return res.status(404).json({ error: "User context not found." });

    // Returns all 4 link vectors back to their specific page engines
    res.json({ 
      youtubeChannel: user.youtubeChannel || "",
      tiktok_link: user.tiktok_link || "",
      instagram_link: user.instagram_link || "",
      facebook_link: user.facebook_link || ""
    });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});

// 🔵 POST: Saves input data handle securely while checking cluster-wide duplicates
app.post("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { youtubeChannel, tiktok_link, instagram_link, facebook_link } = req.body;

    let updateData = {};

    // 1. YouTube Validation Check
    if (youtubeChannel !== undefined) {
      if (youtubeChannel !== "") {
        const linkExists = await User.findOne({ youtubeChannel: youtubeChannel, username: { $ne: decoded.user } });
        if (linkExists) return res.status(409).json({ isDuplicate: true, error: "Channel already exists!" });
      }
      updateData.youtubeChannel = youtubeChannel;
    }

    // 2. TikTok Validation Check
    if (tiktok_link !== undefined) {
      if (tiktok_link !== "") {
        const linkExists = await User.findOne({ tiktok_link: tiktok_link, username: { $ne: decoded.user } });
        if (linkExists) return res.status(409).json({ isDuplicate: true, error: "TikTok link already exists!" });
      }
      updateData.tiktok_link = tiktok_link;
    }

    // 3. Instagram Validation Check
    if (instagram_link !== undefined) {
      if (instagram_link !== "") {
        const linkExists = await User.findOne({ instagram_link: instagram_link, username: { $ne: decoded.user } });
        if (linkExists) return res.status(409).json({ isDuplicate: true, error: "Instagram profile already exists!" });
      }
      updateData.instagram_link = instagram_link;
    }

    // 4. Facebook Validation Check
    if (facebook_link !== undefined) {
      if (facebook_link !== "") {
        const linkExists = await User.findOne({ facebook_link: facebook_link, username: { $ne: decoded.user } });
        if (linkExists) return res.status(409).json({ isDuplicate: true, error: "Facebook profile already exists!" });
      }
      updateData.facebook_link = facebook_link;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Required link parameters are missing." });
    }

    await User.findOneAndUpdate({ username: decoded.user }, updateData);
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});

// 🔴 DELETE: Clears single fields based on query context params (?platform=instagram)
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
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});


/* ---------------- AUTH MIDDLEWARE ---------------- */
function auth(req, res, next) {
  const token = req.cookies.token || req.query.auth_token || req.query.token;
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

/* ---------- LINKING THE EXTERNAL PAGE.JS ROUTER ROUTE EXTENSION ---------- */
// Placed here so specific page.js endpoints process before wildcards drop through
const otherPagesRouter = require("./page.js");
app.use("/", otherPagesRouter);
/* ------------------------------------------------------------------------- */

/* ---------------- DYNAMIC WORKSPACE FILE ROUTER ---------------- */
app.get("/:page.html", auth, (req, res) => {
  const allowedPages = ["youtube", "tiktok", "instagram", "facebook"];
  const pageName = req.params.page;

  if (!allowedPages.includes(pageName)) {
    return res.status(404).send("Page not found.");
  }

  const fileName = `${pageName}.html`;

  const privatePath = path.join(__dirname, "private", fileName);
  const rootPath = path.join(__dirname, fileName);
  const publicPath = path.join(__dirname, "public", fileName);

  if (fs.existsSync(privatePath)) res.sendFile(privatePath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else if (fs.existsSync(publicPath)) res.sendFile(publicPath);
  else res.status(404).send(`Error: File ${fileName} cannot be located.`);
});

/* ---------------- START APPLICATION SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is listening securely on port ${PORT}`);
});
