require("dotenv").config();
const mongoose = require("mongoose");

let isConnected = false;

async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing from environment variables");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
  console.log("✅ Database connected successfully");
}

module.exports = { connectToDatabase };
