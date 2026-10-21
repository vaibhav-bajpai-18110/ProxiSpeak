
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("./src/models/User");

async function testDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected!");

    const testUser = await User.findOneAndUpdate(
      { userId: "proxispeak-test-user" },
      { username: "TestUser" },
      {
  upsert: true,
  returnDocument: "after",
  runValidators: true
}
    );

    console.log("User saved successfully:");
    console.log(testUser);

    const foundUser = await User.findOne({
      userId: "proxispeak-test-user"
    });

    console.log("User retrieved successfully:");
    console.log(foundUser);

  } catch (error) {
    console.error("Database test failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

testDatabase();
