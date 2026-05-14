const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");

const app = express();

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: "ns-platform-secret-key",
  resave: false,
  saveUninitialized: false
}));

app.use(express.static("public"));

/* ---------------- FAKE DATABASE (for now) ---------------- */
const users = [];

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

/* ---------------- SIGNUP ---------------- */
app.post("/signup", async (req, res) => {
  const { email, username, password } = req.body;

  if (!isGmail(email) || !isUsername(username) || !isPassword(password)) {
    return res.send("Invalid format (check email, username, password rules)");
  }

  const exists = users.find(u => u.username === username);
  if (exists) return res.send("Username already exists");

  const hashed = await bcrypt.hash(password, 10);

  users.push({
    email,
    username,
    password: hashed
  });

  req.session.user = username;

  res.redirect("/index.html");
});

/* ---------------- LOGIN ---------------- */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!isUsername(username) || !isPassword(password)) {
    return res.send("Invalid format");
  }

  const user = users.find(u => u.username === username);

  if (!user) {
    return res.send("Incorrect username or password");
  }

  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.send("Incorrect username or password");
  }

  req.session.user = username;

  res.redirect("/index.html");
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

/* ---------------- PROTECTED PAGES ---------------- */
app.get("/youtube.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "youtube.html"));
});

app.get("/instagram.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "instagram.html"));
});

app.get("/tiktok.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tiktok.html"));
});

app.get("/facebook.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "facebook.html"));
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