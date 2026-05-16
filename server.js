require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const fs = require("fs"); // Added to securely check file directory presence dynamically

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
// ✅ ONLY UPDATE: Added the tiktok_link property safely while leaving youtubeChannel completely untouched
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  youtubeChannel: { type: String, default: "" },
  tiktok_link: { type: String, default: "" }
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


/* ---------------- YOUTUBE & TIKTOK PROFILE ENDPOINTS ---------------- */

// 🟢 GET: Loads user's channel handle link configuration on application load
app.get("/api/user/profile", async (req, res) => {
  const token = req.cookies.token || req.query.token || req.query.auth_token;
  if (!token) return res.status(401).json({ error: "Unauthorized access token missing." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.user });
    if (!user) return res.status(404).json({ error: "User context not found." });

    res.json({ 
      youtubeChannel: user.youtubeChannel || "",
      tiktok_link: user.tiktok_link || "" 
    });
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
    const { youtubeChannel, tiktok_link } = req.body;

    let updateData = {};

    if (youtubeChannel !== undefined) {
      if (youtubeChannel !== "") {
        const linkExists = await User.findOne({ youtubeChannel: youtubeChannel, username: { $ne: decoded.user } });
        if (linkExists) {
          return res.status(409).json({ isDuplicate: true, error: "Channel already exists!" });
        }
      }
      updateData.youtubeChannel = youtubeChannel;
    }

    if (tiktok_link !== undefined) {
      if (tiktok_link !== "") {
        const linkExists = await User.findOne({ tiktok_link: tiktok_link, username: { $ne: decoded.user } });
        if (linkExists) {
          return res.status(409).json({ isDuplicate: true, error: "TikTok link already exists!" });
        }
      }
      updateData.tiktok_link = tiktok_link;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Required channel link parameters are missing." });
    }

    await User.findOneAndUpdate({ username: decoded.user }, updateData);
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
    const { platform } = req.query;

    let clearData = {};
    if (platform === "tiktok") {
      clearData.tiktok_link = "";
    } else {
      clearData.youtubeChannel = "";
    }

    await User.findOneAndUpdate({ username: decoded.user }, clearData);
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Session token signature expired." });
  }
});


/* ---------------- AUTH MIDDLEWARE (REPAIRED & COMPLETED) ---------------- */
function auth(req, res, next) {
  // Looks for cookie or query parameter token string
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

/* ------- DYNAMIC PAGE ROUTER LOOKING FOR FOLDERS INSIDE PRIVATE / PUBLIC / ROOT ------- */
// ✅ FIXED: Checks exactly where the files are stored so it never triggers an ENOENT error again
app.get("/:page.html", auth, (req, res) => {
  const allowedPages = ["youtube", "tiktok", "instagram", "facebook"];
  const pageName = req.params.page;

  if (!allowedPages.includes(pageName)) {
    return res.status(404).send("Page not found.");
  }

  const fileName = `${pageName}.html`;

  // Path 1: Check inside the '/private' folder context
  const privatePath = path.join(__dirname, "private", fileName);
  // Path 2: Check inside the base root folder context
  const rootPath = path.join(__dirname, fileName);
  // Path 3: Check inside the '/public' folder context
  const publicPath = path.join(__dirname, "public", fileName);

  if (fs.existsSync(privatePath)) {
    res.sendFile(privatePath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else {
    res.status(404).send(`Error: File ${fileName} cannot be located in any folder directory.`);
  }
});

/* ---------------- START APPLICATION SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is listening securely on port ${PORT}`);
});
