const mongoose = require("mongoose");

const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017/proxispeak";

// Mongoose connection state lifecycle monitoring
mongoose.connection.on("disconnected", () => {
  console.warn("[MONGODB EVENT] Database disconnected. Operating in in-memory fallback mode.");
});
mongoose.connection.on("error", (err) => {
  console.error("[MONGODB EVENT ERROR]:", err.message);
});
mongoose.connection.on("reconnected", () => {
  console.log("[MONGODB EVENT] Database reconnected successfully.");
});

async function connectDB(customUri) {
  const mongoURI = customUri || process.env.MONGODB_URI || DEFAULT_MONGO_URI;

  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[MONGODB] Connected successfully to ${mongoURI}`);
    return mongoose.connection;
  } catch (err) {
    console.error(`[MONGODB ERROR] Connection failed: ${err.message}`);
    // Non-blocking fallback for offline/isolated environments
    return null;
  }
}

async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("[MONGODB] Disconnected successfully");
  }
}

connectDB.connectDB = connectDB;
connectDB.disconnectDB = disconnectDB;
connectDB.mongoose = mongoose;

module.exports = connectDB;
