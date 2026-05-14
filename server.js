require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

const app = express();

/* ---------------- MONGODB CONNECTION ---------------- */
if (!process.env.MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is missing in Replit Secrets!");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Database connected successfully!"))
  .catch((err) => console.error("Database connection failed:", err));

/* ---------------- USER MODEL ---------------- */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model("User", userSchema);

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: "ns-platform-secret-key",
    resave: false,
    saveUninitialized: false,
  }),
);

// This serves public files (login, signup, index) automatically
app.use(express.static("public"));

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

    if (!isGmail(email) || !isUsername(username) || !isPassword(password)) {
      return res.send("Invalid signup format rules.");
    }

    const usernameExists = await User.findOne({ username });
    if (usernameExists) return res.send("Username already exists.");

    const emailExists = await User.findOne({ email });
    if (emailExists) return res.send("Email already registered.");

    const hashed = await bcrypt.hash(password, 10);

    await User.create({
      email,
      username,
      password: hashed,
    });

    req.session.user = username;
    res.redirect("/index.html");
  } catch (error) {
    console.error(error);
    res.send("An error occurred during signup.");
  }
});

/* ---------------- LOGIN ROUTE ---------------- */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

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
    res.redirect("/index.html");
  } catch (error) {
    console.error(error);
    res.send("An error occurred during login.");
  }
});

/* ---------------- LOGIN CHECK API ---------------- */
app.get("/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

/* ---------------- AUTH MIDDLEWARE ---------------- */
function auth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  next();
}

/* ---------------- PROTECTED PAGES (Now pulling from private folder) ---------------- */
app.get("/youtube.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "youtube.html"));
});

app.get("/instagram.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "instagram.html"));
});

app.get("/tiktok.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "tiktok.html"));
});

app.get("/facebook.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "facebook.html"));
});

/* ---------------- HOME ---------------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log("Server running on " + HOST + ":" + PORT);
});
