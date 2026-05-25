// page.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

// Helper Auth Middleware (copied from your server.js logic)
// This ensures your new pages remain secure under the same JWT rules
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "ns-platform-super-secret-key";

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

/* ---------------- ADD YOUR NEW PAGES & MONGO ROUTING HERE ---------------- */

// Example 1: Serving a brand new static or dynamic page
router.get("/dashboard.html", auth, (req, res) => {
  // You can safely serve files from your directory
  res.send(`<h1>Welcome to the New Dashboard, ${req.user}!</h1> <p>This page is running on page.js via the same port!</p>`);
});

// Example 2: Interacting with MongoDB on your new pages
router.get("/api/other-data", auth, async (req, res) => {
  try {
    // Access your existing User model registered in server.js
    const User = mongoose.model("User"); 
    
    // Fetch data from MongoDB cluster
    const currentUserData = await User.findOne({ username: req.user });
    
    res.json({
      message: "Hello from the page.js router!",
      userEmail: currentUserData.email
    });
  } catch (error) {
    res.status(500).json({ error: "MongoDB lookup failed inside page.js" });
  }
});

// CRITICAL: Export the router so server.js can hook into it
module.exports = router;
