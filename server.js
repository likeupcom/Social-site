require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo"); // Added to store sessions securely in MongoDB
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

const app = express();

// Required for Hugging Face Spaces reverse-proxy cookie tracking
app.set("trust proxy", 1); 

/* ---------------- FIX REPLIT & HUGGINGFACE SCRIPT BLOCKING (CSP) ---------------- */
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

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Database connected successfully"))
  .catch((err) => console.error("❌ Database connection failed:", err));

/* ---------------- USER MODEL ---------------- */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});

const User = mongoose.model("User", userSchema);

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configured session tracking to write directly into MongoDB Atlas
app.use(
  session({
    secret: "ns-platform-secret-key",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: "sessions"
    }),
    cookie: { 
      secure: true, // Set to true to work over Hugging Face's HTTPS proxy
      sameSite: "none", // Allows the session cookie to persist inside cross-site space iframes
      maxAge: 1000 * 60 * 60 * 24 // Cookie expires in 24 hours
    },
  }),
);

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

/* ---------------- SIGNUP ROUTE ---------------- */
app.post("/signup", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    console.log("Signup request:", req.body);

    if (!email || !username || !password) {
      return res.send("Fill all fields.");
    }

    if (!isGmail(email) || !isUsername(username) || !isPassword(password)) {
      return res.send("Invalid signup format rules.");
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

    req.session.user = username;

    // Forces session save completion inside MongoDB before directing browser home
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.send("Signup login tracking error.");
      }
      res.redirect("/index.html");
    });

  } catch (error) {
    console.error(error);
    res.send("Signup error.");
  }
});

/* ---------------- LOGIN ROUTE ---------------- */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log("Login request:", req.body);

    if (!username || !password) {
      return res.send("Fill all fields.");
    }

    if (!isUsername(username) || !isPassword(password)) {
      return res.send("Invalid login format rules.");
    }

    const user = await User.findOne({ username });

    if (!user) {
      return res.send("Incorrect username or password.");
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.send("Incorrect username or password.");
    }

    req.session.user = username;

    // Forces session save completion inside MongoDB on log-in
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.send("Login tracking error.");
      }
      res.redirect("/index.html");
    });

  } catch (error) {
    console.error(error);
    res.send("Login error.");
  }
});

/* ---------------- LOGIN CHECK API ---------------- */
app.get("/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

/* ---------------- LOGOUT ---------------- */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

/* ---------------- AUTH MIDDLEWARE ---------------- */
function auth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  next();
}

/* ---------------- PROTECTED PAGES (CLEAN URLS) ---------------- */
app.get("/youtube", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "youtube.html"));
});

app.get("/instagram", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "instagram.html"));
});

app.get("/tiktok", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "tiktok.html"));
});

app.get("/facebook", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "facebook.html"));
});

/* ---------------- HOME ---------------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- START SERVER ---------------- */
const PORT = 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`✅ Server running at http://${HOST}:${PORT}`);
});
