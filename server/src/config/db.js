const mongoose = require("mongoose");

async function connectDB() {
  const mongoURI = process.env.MONGODB_URI;

  if (!mongoURI) {
    throw new Error("MONGODB_URI is missing from environment variables");
  }

  await mongoose.connect(mongoURI);
  console.log("MongoDB connected successfully");
}

module.exports = connectDB;