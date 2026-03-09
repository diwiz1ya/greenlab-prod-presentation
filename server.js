const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3010;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "greenlab-demo.sqlite");
const CLEAN_CLOUD_API_BASE = process.env.CLEAN_CLOUD_API_BASE || "https://cleancloudapp.com/api";
const CLEAN_CLOUD_API_TOKEN = process.env.CLEAN_CLOUD_API_TOKEN || process.env.CLEANCLOUD_API_TOKEN || "";
const CLEAN_CLOUD_WEBHOOK_TOKEN = process.env.CLEAN_CLOUD_WEBHOOK_TOKEN || "";
const CLEAN_CLOUD_SYNC_RETRY_LIMIT = Number(process.env.CLEAN_CLOUD_SYNC_RETRY_LIMIT || 5);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    allowed_stations TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    cleancloud_order_id TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    service_tier TEXT NOT NULL,
    status TEXT NOT NULL,
    cleancloud_status TEXT NOT NULL,
    ready_for_pickup INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS baskets (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    basket_code TEXT NOT NULL UNIQUE,
    basket_type TEXT NOT NULL,
    station TEXT NOT NULL,
    status TEXT NOT NULL,
    qr_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS scan_events (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    basket_id INTEGER,
    station TEXT NOT NULL,
    actor TEXT NOT NULL,
    result TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(basket_id) REFERENCES baskets(id)
  );

  CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT
  );
`);

ensureSchema();

const sessions = new Map();

const stationLabels = {
  overview: "Обзор",
  sorting: "Сортировка",
  washing: "Стирка",
  qc: "Контроль качества (QC)",
  drying: "Сушка",
  ironing: "Глажка",
  pickup: "Выдача"
};

const productionFlow = ["washing", "qc", "drying", "ironing", "pickup"];
const flowIndex = Object.fromEntries(productionFlow.map((station, index) => [station, index]));

seedDemoData();

function nowIso() {
  return new Date().toISOString();
}

function hasColumn(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function ensureSchema() {
  if (!hasColumn("sync_queue", "attempts")) {
    db.exec("ALTER TABLE sync_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn("sync_queue", "last_error")) {
    db.exec("ALTER TABLE sync_queue ADD COLUMN last_error TEXT;");
  }
}

function normalizeLegacyData() {
  db.exec(`
    UPDATE orders SET status = 'qc' WHERE status = 'washing_qc';
    UPDATE baskets SET station = 'qc' WHERE station = 'washing_qc';
    UPDATE baskets SET status = 'qc' WHERE status = 'washing_qc';
    UPDATE users
    SET allowed_stations = REPLACE(allowed_stations, '"washing_qc"', '"qc"')
    WHERE allowed_stations LIKE '%washing_qc%';
  `);
}

function ensureCurrentUsers() {
  const rows = db.prepare("SELECT id, username, allowed_stations FROM users").all();
  const updateAllowed = db.prepare("UPDATE users SET allowed_stations = ? WHERE id = ?");

  for (const row of rows) {
    let allowedStations = [];
    try {
      allowedStations = JSON.parse(row.allowed_stations);
      if (!Array.isArray(allowedStations)) {
        allowedStations = [];
      }
    } catch {
      allowedStations = [];
    }

    let changed = false;

    if (row.username === "manager" && !allowedStations.includes("qc")) {
      const washingIndex = allowedStations.indexOf("washing");
      if (washingIndex >= 0) {
        allowedStations.splice(washingIndex + 1, 0, "qc");
      } else {
        allowedStations.push("qc");
      }
      changed = true;
    }

    if (row.username === "qc") {
      const expected = ["qc", "overview"];
      if (JSON.stringify(allowedStations) !== JSON.stringify(expected)) {
        allowedStations = expected;
        changed = true;
      }
    }

    if (changed) {
      updateAllowed.run(JSON.stringify(allowedStations), row.id);
    }
  }

  const qcUserExists = db.prepare("SELECT id FROM users WHERE username = ?").get("qc");
  if (!qcUserExists) {
    db.prepare(`
      INSERT INTO users (username, password, display_name, role, allowed_stations)
      VALUES (?, ?, ?, ?, ?)
    `).run("qc", "demo123", "Оператор контроля качества", "qc_operator", JSON.stringify(["qc", "overview"]));
  }
}

function seedDemoData(options = {}) {
  const force = Boolean(options.force);

  if (force) {
    db.exec(`
      DELETE FROM webhook_events;
      DELETE FROM sync_queue;
      DELETE FROM scan_events;
      DELETE FROM baskets;
      DELETE FROM orders;
      DELETE FROM users;
    `);
  } else {
    const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    if (userCount > 0) {
      normalizeLegacyData();
      ensureCurrentUsers();
      return false;
    }
  }

  const users = [
    ["sorting", "demo123", "Оператор сортировки", "sorting_operator", ["sorting", "overview"]],
    ["washing", "demo123", "Оператор стирки", "washing_operator", ["washing", "overview"]],
    ["qc", "demo123", "Оператор контроля качества", "qc_operator", ["qc", "overview"]],
    ["drying", "demo123", "Оператор сушки", "drying_operator", ["drying", "overview"]],
    ["ironing", "demo123", "Оператор глажки", "ironing_operator", ["ironing", "overview"]],
    ["pickup", "demo123", "Оператор выдачи", "pickup_operator", ["pickup", "overview"]],
    ["manager", "demo123", "Менеджер филиала", "manager", ["overview", "sorting", "washing", "qc", "drying", "ironing", "pickup"]]
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (username, password, display_name, role, allowed_stations)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const [username, password, displayName, role, allowedStations] of users) {
    insertUser.run(username, password, displayName, role, JSON.stringify(allowedStations));
  }

  const timestamp = nowIso();
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      public_id, cleancloud_order_id, customer_name, service_tier, status,
      cleancloud_status, ready_for_pickup, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertOrder.run("GL-2401", "CC-10001", "Ayu Prasetyo", "Daya", "sorting", "Новый заказ", 0, timestamp, timestamp);
  insertOrder.run("GL-2402", "CC-10002", "Mateo Silva", "Vanish", "washing", "В работе", 0, timestamp, timestamp);
  insertOrder.run("GL-2403", "CC-10003", "Nina Kurnia", "Eco", "qc", "В работе", 0, timestamp, timestamp);
  insertOrder.run("GL-2404", "CC-10004", "Raka Wijaya", "Стандарт", "pickup", "Готов к выдаче", 1, timestamp, timestamp);

  const orderMap = new Map(
    db.prepare("SELECT id, public_id FROM orders").all().map((row) => [row.public_id, row.id])
  );

  const insertBasket = db.prepare(`
    INSERT INTO baskets (
      order_id, basket_code, basket_type, station, status, qr_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBasket.run(orderMap.get("GL-2402"), "B-2402-1", "Белое", "washing", "washing", "QR:B-2402-1", timestamp, timestamp);
  insertBasket.run(orderMap.get("GL-2402"), "B-2402-2", "Цветное", "washing", "washing", "QR:B-2402-2", timestamp, timestamp);
  insertBasket.run(orderMap.get("GL-2403"), "B-2403-1", "Ручная стирка", "qc", "qc", "QR:B-2403-1", timestamp, timestamp);
  insertBasket.run(orderMap.get("GL-2404"), "B-2404-1", "Белое", "pickup", "pickup", "QR:B-2404-1", timestamp, timestamp);

  const pickupBasketId = db.prepare("SELECT id FROM baskets WHERE basket_code = ?").get("B-2404-1").id;
  db.prepare(`
    INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
    VALUES (?, ?, 'pickup', 'system', 'ok', 'Корзина готова к выдаче.', ?)
  `).run(orderMap.get("GL-2404"), pickupBasketId, timestamp);

  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1000000) {
        reject(new Error("Слишком большой запрос"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  };

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404);
      res.end("Не найдено");
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(contents);
  });
}

function auth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !sessions.has(token)) {
    return null;
  }
  return sessions.get(token);
}

function requireAuth(req, res) {
  const session = auth(req);
  if (!session) {
    json(res, 401, { error: "Требуется авторизация" });
    return null;
  }
  return session;
}

function requireManager(session, res) {
  if (session.role !== "manager") {
    json(res, 403, { error: "Нужна роль менеджера" });
    return false;
  }
  return true;
}

function requireStationAccess(session, station, res) {
  if (!session.allowedStations.includes(station)) {
    json(res, 403, { error: "Нет доступа к станции", station, label: stationLabels[station] || station });
    return false;
  }
  return true;
}

function getStationCard(station, session) {
  return {
    key: station,
    label: stationLabels[station],
    allowed: session.allowedStations.includes(station)
  };
}

function getOrderDetails(orderId) {
  const order = db.prepare(`
    SELECT id, public_id, cleancloud_order_id, customer_name, service_tier, status,
           cleancloud_status, ready_for_pickup, created_at, updated_at
    FROM orders
    WHERE id = ?
  `).get(orderId);

  if (!order) {
    return null;
  }

  const baskets = db.prepare(`
    SELECT id, basket_code, basket_type, station, status, qr_code, created_at, updated_at
    FROM baskets
    WHERE order_id = ?
    ORDER BY id
  `).all(orderId);

  const scans = db.prepare(`
    SELECT id, station, actor, result, message, created_at, basket_id
    FROM scan_events
    WHERE order_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 10
  `).all(orderId);

  return {
    ...order,
    ready_for_pickup: Boolean(order.ready_for_pickup),
    baskets,
    scans
  };
}

function getOverview() {
  const counts = {};
  for (const station of Object.keys(stationLabels)) {
    counts[station] = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = ?").get(station).count;
  }
  counts.ready = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE ready_for_pickup = 1").get().count;

  const orders = db.prepare(`
    SELECT id, public_id, customer_name, service_tier, status, cleancloud_status, ready_for_pickup, updated_at
    FROM orders
    ORDER BY id
  `).all().map((row) => ({ ...row, ready_for_pickup: Boolean(row.ready_for_pickup) }));

  return { counts, orders };
}

function listStationOrders(station) {
  return db.prepare(`
    SELECT id, public_id, customer_name, service_tier, status, cleancloud_status, ready_for_pickup, updated_at
    FROM orders
    WHERE status = ?
    ORDER BY id
  `).all(station).map((row) => ({ ...row, ready_for_pickup: Boolean(row.ready_for_pickup) }));
}

function isCleanCloudSuccess(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStatusCode(value) {
  const asText = String(value ?? "").trim();
  if (asText === "0" || asText === "1" || asText === "2" || asText === "4" || asText === "5") {
    return asText;
  }
  return null;
}

function mapLocalStatusToCleanCloudStatusCode(value) {
  const normalizedCode = normalizeStatusCode(value);
  if (normalizedCode) return normalizedCode;

  const normalizedText = String(value ?? "").trim().toLowerCase();
  if (!normalizedText) return null;

  if (
    normalizedText === "новый заказ" ||
    normalizedText === "в работе" ||
    normalizedText === "sorting" ||
    normalizedText === "washing" ||
    normalizedText === "qc" ||
    normalizedText === "drying" ||
    normalizedText === "ironing"
  ) {
    return "0";
  }
  if (normalizedText === "готов к выдаче" || normalizedText === "pickup") {
    return "1";
  }
  if (normalizedText === "завершён" || normalizedText === "завершен" || normalizedText === "overview" || normalizedText === "completed") {
    return "2";
  }
  return null;
}

function mapCleanCloudStatusToLocalOrderState(statusCode) {
  const code = normalizeStatusCode(statusCode);
  if (code === "0") {
    return {
      status: "washing",
      cleancloudStatus: "В работе",
      readyForPickup: false
    };
  }
  if (code === "1") {
    return {
      status: "pickup",
      cleancloudStatus: "Готов к выдаче",
      readyForPickup: true
    };
  }
  if (code === "2") {
    return {
      status: "overview",
      cleancloudStatus: "Завершён",
      readyForPickup: false
    };
  }
  if (code === "4" || code === "5") {
    return {
      status: "overview",
      cleancloudStatus: "Отменён",
      readyForPickup: false
    };
  }
  return null;
}

function isLikelyNumericOrderId(orderId) {
  return /^\d+$/.test(String(orderId ?? ""));
}

function queueSync(orderId, action, payload) {
  const createdAt = nowIso();
  const payloadJson = JSON.stringify(payload);
  const duplicate = db.prepare(`
    SELECT id
    FROM sync_queue
    WHERE order_id = ? AND action = ? AND payload = ? AND status IN ('pending', 'processing')
    LIMIT 1
  `).get(orderId, action, payloadJson);

  if (duplicate) {
    return { ok: true, queued: false, reason: "duplicate" };
  }

  db.prepare(`
    INSERT INTO sync_queue (order_id, action, payload, status, created_at, processed_at, attempts, last_error)
    VALUES (?, ?, ?, 'pending', ?, NULL, 0, NULL)
  `).run(orderId, action, payloadJson, createdAt);
  return { ok: true, queued: true };
}

async function callCleanCloudUpdateOrder(orderId, statusCode) {
  const response = await fetch(`${CLEAN_CLOUD_API_BASE}/updateOrder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: CLEAN_CLOUD_API_TOKEN,
      orderID: String(orderId),
      status: String(statusCode)
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, details: data };
  }
  if (!isCleanCloudSuccess(data.Success)) {
    return { ok: false, error: data.Error || "CleanCloud returned Success=false", details: data };
  }

  return { ok: true, data };
}

function markSyncQueueProcessed(id, note = null) {
  db.prepare(`
    UPDATE sync_queue
    SET status = 'processed', processed_at = ?, last_error = ?
    WHERE id = ?
  `).run(nowIso(), note, id);
}

function markSyncQueueRetry(id, attempts, errorText) {
  const nextAttempts = attempts + 1;
  const shouldFail = nextAttempts >= CLEAN_CLOUD_SYNC_RETRY_LIMIT;
  const status = shouldFail ? "failed" : "pending";
  const processedAt = shouldFail ? nowIso() : null;
  db.prepare(`
    UPDATE sync_queue
    SET status = ?, attempts = ?, last_error = ?, processed_at = ?
    WHERE id = ?
  `).run(status, nextAttempts, errorText, processedAt, id);
}

let syncInProgress = false;

async function processSyncQueue() {
  if (syncInProgress) return;
  syncInProgress = true;

  const pending = db.prepare(`
    SELECT id, action, payload, attempts
    FROM sync_queue
    WHERE status = 'pending'
    ORDER BY id
    LIMIT 20
  `).all();

  try {
    for (const item of pending) {
      db.prepare("UPDATE sync_queue SET status = 'processing' WHERE id = ? AND status = 'pending'").run(item.id);

      if (item.action !== "cleancloud.status") {
        markSyncQueueProcessed(item.id, "Skipped unsupported action");
        continue;
      }

      const payload = safeJsonParse(item.payload);
      if (!payload) {
        markSyncQueueRetry(item.id, item.attempts, "Invalid payload JSON");
        continue;
      }

      const statusCode = mapLocalStatusToCleanCloudStatusCode(payload.status);
      if (!statusCode) {
        markSyncQueueRetry(item.id, item.attempts, "Unknown status mapping");
        continue;
      }

      if (!CLEAN_CLOUD_API_TOKEN) {
        markSyncQueueProcessed(item.id, "Skipped: CLEAN_CLOUD_API_TOKEN is not set");
        continue;
      }

      if (!isLikelyNumericOrderId(payload.orderId)) {
        markSyncQueueProcessed(item.id, "Skipped: cleancloud order id is not numeric");
        continue;
      }

      try {
        const result = await callCleanCloudUpdateOrder(payload.orderId, statusCode);
        if (result.ok) {
          markSyncQueueProcessed(item.id, null);
        } else {
          markSyncQueueRetry(item.id, item.attempts, result.error);
        }
      } catch (error) {
        markSyncQueueRetry(item.id, item.attempts, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    syncInProgress = false;
  }
}

setInterval(() => {
  processSyncQueue().catch((error) => {
    console.error("Sync queue processing failed:", error);
  });
}, 3000).unref();

function getOrderProgressFromBaskets(orderId) {
  const rows = db.prepare(`
    SELECT station, COUNT(*) AS count
    FROM baskets
    WHERE order_id = ?
    GROUP BY station
  `).all(orderId);

  if (!rows.length) {
    return {
      status: "sorting",
      cleancloudStatus: "Новый заказ",
      readyForPickup: false
    };
  }

  let minIndex = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const index = flowIndex[row.station];
    if (index === undefined) {
      continue;
    }
    if (index < minIndex) {
      minIndex = index;
    }
  }

  if (!Number.isFinite(minIndex)) {
    minIndex = flowIndex.washing;
  }

  const status = productionFlow[minIndex];
  const readyForPickup = status === "pickup";

  return {
    status,
    cleancloudStatus: readyForPickup ? "Готов к выдаче" : "В работе",
    readyForPickup
  };
}

function refreshOrderStatusFromBaskets(orderId, cleancloudOrderId, timestamp) {
  const previous = db.prepare("SELECT ready_for_pickup FROM orders WHERE id = ?").get(orderId);
  const next = getOrderProgressFromBaskets(orderId);

  db.prepare(`
    UPDATE orders
    SET status = ?, cleancloud_status = ?, ready_for_pickup = ?, updated_at = ?
    WHERE id = ?
  `).run(next.status, next.cleancloudStatus, next.readyForPickup ? 1 : 0, timestamp, orderId);

  if (next.readyForPickup && !previous.ready_for_pickup) {
    queueSync(orderId, "cleancloud.status", {
      orderId: cleancloudOrderId,
      status: "Готов к выдаче"
    });
  }

  return next;
}

function createBaskets(orderId, types, actor) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) {
    return { error: "Заказ не найден", status: 404 };
  }
  if (order.status !== "sorting") {
    return { error: "Заказ не находится на сортировке", status: 400 };
  }

  const existing = db.prepare("SELECT COUNT(*) AS count FROM baskets WHERE order_id = ?").get(orderId).count;
  if (existing > 0) {
    return { error: "Корзины уже созданы", status: 400 };
  }

  const timestamp = nowIso();
  const insertBasket = db.prepare(`
    INSERT INTO baskets (order_id, basket_code, basket_type, station, status, qr_code, created_at, updated_at)
    VALUES (?, ?, ?, 'washing', 'washing', ?, ?, ?)
  `);

  types.forEach((type, index) => {
    const basketCode = `B-${order.public_id.slice(3)}-${index + 1}`;
    insertBasket.run(orderId, basketCode, type, `QR:${basketCode}`, timestamp, timestamp);
  });

  db.prepare(`
    UPDATE orders
    SET status = 'washing', cleancloud_status = 'В работе', ready_for_pickup = 0, updated_at = ?
    WHERE id = ?
  `).run(timestamp, orderId);

  db.prepare(`
    INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
    VALUES (?, NULL, 'sorting', ?, 'ok', 'Корзины созданы, QR-этикетки подготовлены.', ?)
  `).run(orderId, actor, timestamp);

  queueSync(orderId, "cleancloud.status", {
    orderId: order.cleancloud_order_id,
    status: "В работе"
  });

  return { ok: true, order: getOrderDetails(orderId) };
}

function scanBasket(station, qrCode, actor) {
  const basket = db.prepare(`
    SELECT b.*, o.cleancloud_order_id, o.id AS order_db_id
    FROM baskets b
    JOIN orders o ON o.id = b.order_id
    WHERE b.qr_code = ?
  `).get(qrCode);

  if (!basket) {
    return { status: 404, payload: { ok: false, message: "QR-код не найден." } };
  }

  const timestamp = nowIso();
  const orderId = basket.order_db_id;

  if (basket.station !== station) {
    db.prepare(`
      INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
      VALUES (?, ?, ?, ?, 'error', ?, ?)
    `).run(orderId, basket.id, station, actor, `Корзина относится к станции ${stationLabels[basket.station]}.`, timestamp);

    return {
      status: 409,
      payload: { ok: false, message: `Корзина на станции ${stationLabels[basket.station]}, а не ${stationLabels[station]}.` }
    };
  }

  if (station === "pickup") {
    db.prepare(`
      INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
      VALUES (?, ?, ?, ?, 'ok', 'Корзина подтверждена для выдачи.', ?)
    `).run(orderId, basket.id, station, actor, timestamp);

    return {
      status: 200,
      payload: {
        ok: true,
        message: "Корзина подтверждена. Завершите выдачу заказа.",
        order: getOrderDetails(orderId)
      }
    };
  }

  const currentIndex = flowIndex[station];
  if (currentIndex === undefined || currentIndex >= productionFlow.length - 1) {
    return { status: 400, payload: { ok: false, message: "На этой станции сканирование недоступно." } };
  }

  const nextStation = productionFlow[currentIndex + 1];
  db.prepare(`
    UPDATE baskets
    SET station = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(nextStation, nextStation, timestamp, basket.id);

  refreshOrderStatusFromBaskets(orderId, basket.cleancloud_order_id, timestamp);

  db.prepare(`
    INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
    VALUES (?, ?, ?, ?, 'ok', ?, ?)
  `).run(orderId, basket.id, station, actor, `Корзина переведена на станцию ${stationLabels[nextStation]}.`, timestamp);

  return {
    status: 200,
    payload: {
      ok: true,
      message: `Корзина переведена на станцию ${stationLabels[nextStation]}.`,
      order: getOrderDetails(orderId)
    }
  };
}

function completePickup(orderId, actor) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) {
    return { error: "Заказ не найден", status: 404 };
  }
  if (order.status !== "pickup" || !order.ready_for_pickup) {
    return { error: "Заказ не готов к выдаче", status: 400 };
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE orders
    SET status = 'overview', cleancloud_status = 'Завершён', updated_at = ?
    WHERE id = ?
  `).run(timestamp, orderId);

  db.prepare(`
    INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
    VALUES (?, NULL, 'pickup', ?, 'ok', 'Заказ выдан клиенту.', ?)
  `).run(orderId, actor, timestamp);

  queueSync(orderId, "cleancloud.status", {
    orderId: order.cleancloud_order_id,
    status: "Завершён"
  });

  return { ok: true, order: getOrderDetails(orderId) };
}

function getSyncQueueSummary() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM sync_queue
    GROUP BY status
  `).all();

  return {
    pending: rows.find((row) => row.status === "pending")?.count || 0,
    processing: rows.find((row) => row.status === "processing")?.count || 0,
    processed: rows.find((row) => row.status === "processed")?.count || 0,
    failed: rows.find((row) => row.status === "failed")?.count || 0
  };
}

function listWebhookEvents(limit = 25) {
  return db.prepare(`
    SELECT id, source, event_key, status, message, received_at, processed_at
    FROM webhook_events
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getWebhookEventKey(payload) {
  const candidates = [
    payload?.event_id,
    payload?.eventID,
    payload?.eventId,
    payload?.webhook_id,
    payload?.webhookID,
    payload?.idempotencyKey
  ].filter(Boolean);

  if (candidates.length > 0) {
    return String(candidates[0]);
  }

  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function applyCleanCloudWebhookPayload(payload) {
  const cleanCloudOrderId = String(payload?.orderID || payload?.orderId || "").trim();
  const localStatus = mapCleanCloudStatusToLocalOrderState(payload?.status);

  if (!cleanCloudOrderId) {
    return { status: "ignored", message: "Missing orderID in webhook payload." };
  }

  if (!localStatus) {
    return { status: "ignored", message: "Unsupported or missing webhook status." };
  }

  const order = db.prepare(`
    SELECT id, public_id
    FROM orders
    WHERE cleancloud_order_id = ?
  `).get(cleanCloudOrderId);

  if (!order) {
    return { status: "ignored", message: `No local order mapped to cleancloud_order_id=${cleanCloudOrderId}.` };
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE orders
    SET status = ?, cleancloud_status = ?, ready_for_pickup = ?, updated_at = ?
    WHERE id = ?
  `).run(localStatus.status, localStatus.cleancloudStatus, localStatus.readyForPickup ? 1 : 0, timestamp, order.id);

  db.prepare(`
    INSERT INTO scan_events (order_id, basket_id, station, actor, result, message, created_at)
    VALUES (?, NULL, 'overview', 'cleancloud_webhook', 'ok', ?, ?)
  `).run(order.id, `Webhook обновил статус заказа ${order.public_id}: ${localStatus.cleancloudStatus}.`, timestamp);

  return {
    status: "processed",
    message: `Order ${order.public_id} updated from webhook status ${payload.status}.`
  };
}

function handleCleanCloudWebhook(payload, source) {
  const eventKey = getWebhookEventKey(payload);
  const receivedAt = nowIso();

  try {
    db.prepare(`
      INSERT INTO webhook_events (source, event_key, payload, status, message, received_at, processed_at)
      VALUES (?, ?, ?, 'received', 'Received webhook', ?, NULL)
    `).run(source, eventKey, JSON.stringify(payload || {}), receivedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return {
        ok: true,
        duplicate: true,
        eventKey,
        message: "Duplicate webhook ignored."
      };
    }
    throw error;
  }

  const result = applyCleanCloudWebhookPayload(payload || {});
  db.prepare(`
    UPDATE webhook_events
    SET status = ?, message = ?, processed_at = ?
    WHERE event_key = ?
  `).run(result.status, result.message, nowIso(), eventKey);

  return {
    ok: true,
    duplicate: false,
    eventKey,
    ...result
  };
}

function getScanExportRows(orderId) {
  if (orderId) {
    return db.prepare(`
      SELECT
        se.id,
        o.public_id AS order_public_id,
        o.customer_name,
        COALESCE(b.basket_code, '') AS basket_code,
        se.station,
        se.actor,
        se.result,
        se.message,
        se.created_at
      FROM scan_events se
      JOIN orders o ON o.id = se.order_id
      LEFT JOIN baskets b ON b.id = se.basket_id
      WHERE se.order_id = ?
      ORDER BY datetime(se.created_at) DESC, se.id DESC
    `).all(orderId);
  }

  return db.prepare(`
    SELECT
      se.id,
      o.public_id AS order_public_id,
      o.customer_name,
      COALESCE(b.basket_code, '') AS basket_code,
      se.station,
      se.actor,
      se.result,
      se.message,
      se.created_at
    FROM scan_events se
    JOIN orders o ON o.id = se.order_id
    LEFT JOIN baskets b ON b.id = se.basket_id
    ORDER BY datetime(se.created_at) DESC, se.id DESC
  `).all();
}

function getRecentScansByStation(station, limit) {
  return db.prepare(`
    SELECT
      se.id,
      o.public_id AS order_public_id,
      COALESCE(b.basket_code, '') AS basket_code,
      se.actor,
      se.result,
      se.message,
      se.created_at
    FROM scan_events se
    JOIN orders o ON o.id = se.order_id
    LEFT JOIN baskets b ON b.id = se.basket_id
    WHERE se.station = ?
    ORDER BY datetime(se.created_at) DESC, se.id DESC
    LIMIT ?
  `).all(station, limit);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

function scanRowsToCsv(rows) {
  const columns = [
    "id",
    "order_public_id",
    "customer_name",
    "basket_code",
    "station",
    "actor",
    "result",
    "message",
    "created_at"
  ];

  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }
  return lines.join("\n");
}

function routeApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    readJson(req)
      .then((body) => {
        const user = db.prepare(`
          SELECT id, username, display_name, role, allowed_stations
          FROM users
          WHERE username = ? AND password = ?
        `).get(body.username, body.password);

        if (!user) {
          json(res, 401, { error: "Неверный логин или пароль" });
          return;
        }

        const token = crypto.randomUUID();
        const allowedStations = JSON.parse(user.allowed_stations);
        const session = {
          token,
          userId: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          allowedStations,
          homeStation: allowedStations[0]
        };
        sessions.set(token, session);

        json(res, 200, {
          token,
          user: {
            username: session.username,
            displayName: session.displayName,
            role: session.role,
            allowedStations: session.allowedStations,
            homeStation: session.homeStation
          }
        });
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/cleancloud/webhook") {
    if (CLEAN_CLOUD_WEBHOOK_TOKEN) {
      const providedToken = req.headers["x-webhook-token"] || url.searchParams.get("token");
      if (String(providedToken || "") !== CLEAN_CLOUD_WEBHOOK_TOKEN) {
        json(res, 401, { error: "Invalid webhook token" });
        return true;
      }
    }

    readJson(req)
      .then((body) => {
        const source = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
        const result = handleCleanCloudWebhook(body, String(source));
        json(res, 200, result);
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const session = requireAuth(req, res);
    if (!session) return true;

    json(res, 200, {
      user: {
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        allowedStations: session.allowedStations,
        homeStation: session.homeStation
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = auth(req);
    if (session) sessions.delete(session.token);
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/stations") {
    const session = requireAuth(req, res);
    if (!session) return true;

    json(res, 200, {
      stations: Object.keys(stationLabels).map((station) => getStationCard(station, session))
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/open-station") {
    const session = requireAuth(req, res);
    if (!session) return true;

    readJson(req)
      .then((body) => {
        const station = body.station;
        if (!station || !stationLabels[station]) {
          json(res, 400, { error: "Неизвестная станция" });
          return;
        }

        if (!session.allowedStations.includes(station)) {
          json(res, 403, {
            error: "Нет доступа к станции",
            station,
            label: stationLabels[station],
            allowedStations: session.allowedStations
          });
          return;
        }

        json(res, 200, {
          ok: true,
          station,
          label: stationLabels[station]
        });
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/demo/reset") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireManager(session, res)) return true;

    seedDemoData({ force: true });
    json(res, 200, {
      ok: true,
      message: "Демо-данные сброшены.",
      orders: db.prepare("SELECT COUNT(*) AS count FROM orders").get().count,
      scans: db.prepare("SELECT COUNT(*) AS count FROM scan_events").get().count
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/scans/recent") {
    const session = requireAuth(req, res);
    if (!session) return true;

    const station = url.searchParams.get("station");
    const limitRaw = Number(url.searchParams.get("limit") || 8);
    const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(limitRaw, 30)) : 8;

    if (!station || !stationLabels[station]) {
      json(res, 400, { error: "Неизвестная станция" });
      return true;
    }
    if (!requireStationAccess(session, station, res)) return true;

    json(res, 200, {
      station,
      total: limit,
      rows: getRecentScansByStation(station, limit)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/export/scans") {
    const session = requireAuth(req, res);
    if (!session) return true;

    const format = (url.searchParams.get("format") || "json").toLowerCase();
    const orderIdRaw = url.searchParams.get("orderId");
    const parsedOrderId = orderIdRaw ? Number(orderIdRaw) : null;
    const orderId = Number.isInteger(parsedOrderId) && parsedOrderId > 0 ? parsedOrderId : null;

    if (orderIdRaw && !orderId) {
      json(res, 400, { error: "Некорректный orderId" });
      return true;
    }

    const rows = getScanExportRows(orderId);

    if (format === "json") {
      json(res, 200, {
        exportedAt: nowIso(),
        total: rows.length,
        orderId,
        rows
      });
      return true;
    }

    if (format === "csv") {
      const fileName = orderId ? `scan-log-order-${orderId}.csv` : "scan-log-all.csv";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"${fileName}\"`
      });
      res.end(scanRowsToCsv(rows));
      return true;
    }

    json(res, 400, { error: "Неподдерживаемый формат экспорта" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/overview") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireStationAccess(session, "overview", res)) return true;

    json(res, 200, getOverview());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sync-queue") {
    const session = requireAuth(req, res);
    if (!session) return true;

    json(res, 200, {
      items: db.prepare(`
        SELECT id, order_id, action, payload, status, attempts, last_error, created_at, processed_at
        FROM sync_queue
        ORDER BY id DESC
        LIMIT 25
      `).all(),
      summary: getSyncQueueSummary()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sync/run") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireManager(session, res)) return true;

    processSyncQueue()
      .then(() => {
        json(res, 200, {
          ok: true,
          summary: getSyncQueueSummary()
        });
      })
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/webhooks/events") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireManager(session, res)) return true;

    const limitRaw = Number(url.searchParams.get("limit") || 25);
    const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 25;
    json(res, 200, {
      total: limit,
      rows: listWebhookEvents(limit)
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/cleancloud/test-update") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireManager(session, res)) return true;

    readJson(req)
      .then(async (body) => {
        if (!CLEAN_CLOUD_API_TOKEN) {
          json(res, 400, { error: "CLEAN_CLOUD_API_TOKEN is not set" });
          return;
        }

        const cleanCloudOrderId = String(body.orderId || "").trim();
        if (!cleanCloudOrderId || !isLikelyNumericOrderId(cleanCloudOrderId)) {
          json(res, 400, { error: "orderId must be a numeric CleanCloud order id" });
          return;
        }

        const statusCode = mapLocalStatusToCleanCloudStatusCode(body.status);
        if (!statusCode) {
          json(res, 400, { error: "Unknown status mapping. Use 0/1/2 or local status text." });
          return;
        }

        const result = await callCleanCloudUpdateOrder(cleanCloudOrderId, statusCode);
        if (!result.ok) {
          json(res, 502, { ok: false, error: result.error });
          return;
        }

        json(res, 200, {
          ok: true,
          orderId: cleanCloudOrderId,
          status: statusCode
        });
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/orders/")) {
    const session = requireAuth(req, res);
    if (!session) return true;

    const id = Number(url.pathname.split("/").pop());
    const order = getOrderDetails(id);
    if (!order) {
      json(res, 404, { error: "Заказ не найден" });
      return true;
    }

    json(res, 200, order);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orders") {
    const session = requireAuth(req, res);
    if (!session) return true;

    const station = url.searchParams.get("station");
    if (!station || !stationLabels[station]) {
      json(res, 400, { error: "Неизвестная станция" });
      return true;
    }
    if (!requireStationAccess(session, station, res)) return true;

    json(res, 200, { orders: listStationOrders(station) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sorting/create-baskets") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireStationAccess(session, "sorting", res)) return true;

    readJson(req)
      .then((body) => {
        const types = Array.isArray(body.types) && body.types.length ? body.types : ["Белое", "Цветное", "Ручная стирка"];
        const result = createBaskets(Number(body.orderId), types, session.username);
        if (result.error) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 200, result);
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/scan") {
    const session = requireAuth(req, res);
    if (!session) return true;

    readJson(req)
      .then((body) => {
        if (!body.station || !stationLabels[body.station]) {
          json(res, 400, { error: "Неизвестная станция" });
          return;
        }
        if (!requireStationAccess(session, body.station, res)) return;

        const result = scanBasket(body.station, String(body.qrCode || "").trim(), session.username);
        json(res, result.status, result.payload);
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pickup/complete") {
    const session = requireAuth(req, res);
    if (!session) return true;
    if (!requireStationAccess(session, "pickup", res)) return true;

    readJson(req)
      .then((body) => {
        const result = completePickup(Number(body.orderId), session.username);
        if (result.error) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 200, result);
      })
      .catch((error) => json(res, 400, { error: error.message }));
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    if (!routeApi(req, res, url)) {
      json(res, 404, { error: "Не найдено" });
    }
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Доступ запрещён");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Green Lab demo MVP запущен на http://127.0.0.1:${PORT}`);
});

