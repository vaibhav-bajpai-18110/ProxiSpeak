const http = require("http");
const { spawn } = require("child_process");

async function checkUrl(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text };
}

async function runTest() {
  console.log("Starting server process...");
  const server = spawn("node", ["src/index.js"], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stdout.on("data", (data) => {
    console.log(`[SERVER STDOUT]: ${data.toString().trim()}`);
  });

  server.stderr.on("data", (data) => {
    console.error(`[SERVER STDERR]: ${data.toString().trim()}`);
  });

  // Allow server to spin up
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    console.log("\n--- Testing Route 1: GET http://localhost:5000/ ---");
    const rootRes = await checkUrl("http://localhost:5000/");
    console.log(`Status: ${rootRes.status}`);
    console.log(`Body: ${rootRes.body}`);

    if (rootRes.status === 200 && rootRes.body === "ProxiSpeak Backend is running!") {
      console.log("--> PASS: Root endpoint verified.");
    } else {
      console.error("--> FAIL: Root endpoint unexpected response.");
    }

    console.log("\n--- Testing Route 2: GET http://localhost:5000/api/health ---");
    const healthRes = await checkUrl("http://localhost:5000/api/health");
    console.log(`Status: ${healthRes.status}`);
    console.log(`Body: ${healthRes.body}`);

    const healthJson = JSON.parse(healthRes.body);
    if (healthRes.status === 200 && healthJson.status === "OK" && healthJson.project === "ProxiSpeak") {
      console.log("--> PASS: Health check endpoint verified.");
    } else {
      console.error("--> FAIL: Health check endpoint unexpected response.");
    }

    console.log("\n--- Testing Socket.IO Connection ---");
    // Connect to Socket.io via HTTP polling handshake or socket.io protocol
    const socketRes = await checkUrl("http://localhost:5000/socket.io/?EIO=4&transport=polling");
    console.log(`Socket.IO Polling Handshake Status: ${socketRes.status}`);
    console.log(`Handshake response preview: ${socketRes.body.slice(0, 50)}...`);
    if (socketRes.status === 200) {
      console.log("--> PASS: Socket.IO endpoint active and accepting handshakes.");
    }

  } catch (err) {
    console.error("Verification encountered an error:", err);
  } finally {
    console.log("\nShutting down test server...");
    server.kill("SIGTERM");
    // Give it a moment to terminate
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Server stopped successfully.");
    process.exit(0);
  }
}

runTest();
