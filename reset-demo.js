const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.DEMO_BASE_URL || "http://127.0.0.1:3010";
const files = [
  path.join(__dirname, "data", "greenlab-demo.sqlite"),
  path.join(__dirname, "data", "greenlab-demo.sqlite-shm"),
  path.join(__dirname, "data", "greenlab-demo.sqlite-wal")
];

function removeLocalDatabaseFiles() {
  let removed = 0;
  let locked = false;

  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }

    try {
      fs.unlinkSync(file);
      removed += 1;
      console.log(`removed ${path.basename(file)}`);
    } catch (error) {
      if (error.code === "EBUSY" || error.code === "EPERM") {
        locked = true;
        console.warn(`locked ${path.basename(file)} (${error.code})`);
        continue;
      }
      throw error;
    }
  }

  return { removed, locked };
}

async function resetViaApi() {
  const loginResponse = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "manager", password: "demo123" })
  });

  if (!loginResponse.ok) {
    throw new Error(`login failed: HTTP ${loginResponse.status}`);
  }

  const loginPayload = await loginResponse.json();
  if (!loginPayload.token) {
    throw new Error("login payload missing token");
  }

  const resetResponse = await fetch(`${BASE_URL}/api/demo/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginPayload.token}`
    },
    body: "{}"
  });

  if (!resetResponse.ok) {
    throw new Error(`reset failed: HTTP ${resetResponse.status}`);
  }

  console.log(`demo reset completed via API (${BASE_URL}/api/demo/reset)`);
}

(async () => {
  const local = removeLocalDatabaseFiles();

  if (!local.locked) {
    console.log("demo database reset complete");
    process.exit(0);
  }

  console.log("database is locked by running server, trying API reset...");

  try {
    await resetViaApi();
    process.exit(0);
  } catch (error) {
    console.error("failed to reset via API:", error.message);
    console.error("stop the server and run npm run reset-demo again");
    process.exit(1);
  }
})();
