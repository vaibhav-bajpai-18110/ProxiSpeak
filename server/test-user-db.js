
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const mongoose = require("mongoose");
const User = require("./src/models/User");

async function verifyUserDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connection: PASS");

    const userId = "proxispeak-db-verification-test";
    const username = "Database Test User";

    const savedUser = await User.findOneAndUpdate(
      { userId },
      { $set: { username } },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
      }
    );

    console.log("User save: PASS");

    const readUser = await User.findOne({ userId });

    if (!readUser || readUser.username !== username) {
      throw new Error("Saved user could not be read back correctly.");
    }

    console.log("User read: PASS");
    console.log({
      userId: readUser.userId,
      username: readUser.username,
      createdAt: readUser.createdAt,
      updatedAt: readUser.updatedAt,
    });

    console.log("DATABASE VERIFICATION: PASS");
  } catch (error) {
    console.error("DATABASE VERIFICATION: FAIL", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

verifyUserDatabase();
