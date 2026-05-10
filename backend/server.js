const express = require("express");
const cors = require("cors");
const dns = require("dns");
const { MongoClient, ObjectId } = require("mongodb");
const dnsPromises = dns.promises;

const app = express();
const PORT = 3000;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"]
  })
);
app.use(express.json());

let client = null;
let db = null;
const CONNECTION_TIMEOUT_MS = 10000;
const PUBLIC_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"];
const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

function ok(res, data) {
  return res.json({ success: true, data });
}

function fail(res, error, code = 400) {
  return res.status(code).json({ success: false, error });
}

function ensureDb(res) {
  if (!db) {
    fail(res, "Not connected to any database", 400);
    return false;
  }
  return true;
}

function getCollection(res, name) {
  if (!ensureDb(res)) return null;
  if (!name || typeof name !== "string") {
    fail(res, "Collection name is required", 400);
    return null;
  }
  return db.collection(name);
}

function isValidMongoUri(connectionString) {
  return (
    typeof connectionString === "string" &&
    /^(mongodb(\+srv)?):\/\/.+/i.test(connectionString.trim())
  );
}

function getDbNameFromConnectionString(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const dbName = (parsed.pathname || "").replace(/^\//, "").trim();
    return dbName || null;
  } catch {
    return null;
  }
}

function mapMongoConnectionError(err) {
  const message = (err && err.message ? err.message : "").toLowerCase();
  const code = err && err.code;

  if (message.includes("authentication failed")) {
    return "MongoDB authentication failed. Verify username and password in your connection string.";
  }

  if (
    message.includes("querysrv") ||
    message.includes("ename") ||
    message.includes("enotfound") ||
    message.includes("dns")
  ) {
    return "DNS lookup failed for MongoDB Atlas cluster. Auto-retry via public DNS also failed. Check Atlas hostname, internet, VPN/proxy, or firewall.";
  }

  if (
    message.includes("ssl") ||
    message.includes("tls") ||
    message.includes("certificate")
  ) {
    return "TLS/SSL handshake failed. Ensure your network allows secure Atlas connections and your system time is correct.";
  }

  if (
    message.includes("server selection timed out") ||
    message.includes("timed out") ||
    code === "ETIMEDOUT"
  ) {
    return "Could not reach MongoDB server in time. For Atlas, verify Network Access (IP whitelist) and cluster status.";
  }

  if (message.includes("not authorized")) {
    return "Connected, but user is not authorized for the selected database. Use a database your user can access.";
  }

  if (message.includes("invalid scheme")) {
    return "Invalid connection string format. Use mongodb:// or mongodb+srv:// exactly like MongoDB Compass.";
  }

  if (!message) {
    return "Failed to connect to MongoDB due to an unknown error.";
  }

  return err.message;
}

function isSrvConnection(connectionString) {
  return /^mongodb\+srv:\/\//i.test((connectionString || "").trim());
}

function isDnsSrvError(err) {
  const message = (err && err.message ? err.message : "").toLowerCase();
  return (
    message.includes("querysrv") ||
    message.includes("dns") ||
    message.includes("enotfound") ||
    message.includes("eservfail") ||
    message.includes("ename")
  );
}

async function connectClient(connectionString) {
  const nextClient = new MongoClient(connectionString.trim(), {
    serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS
  });
  await nextClient.connect();
  await nextClient.db("admin").command({ ping: 1 });
  return nextClient;
}

function parseAtlasTxtOptions(txtRecords) {
  const params = new URLSearchParams();
  for (const record of txtRecords || []) {
    const joined = Array.isArray(record) ? record.join("") : "";
    if (!joined) continue;
    for (const pair of joined.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k && !params.has(k)) params.set(k, v);
    }
  }
  return params;
}

async function toStandardMongoUriFromSrv(connectionString) {
  const parsed = new URL(connectionString);
  const host = parsed.hostname;
  if (!host) throw new Error("Invalid Atlas hostname in connection string.");

  const srvName = `_mongodb._tcp.${host}`;
  const srvRecords = await dnsPromises.resolveSrv(srvName);
  if (!srvRecords || srvRecords.length === 0) {
    throw new Error("Atlas SRV lookup returned no hosts.");
  }

  const hosts = srvRecords
    .slice()
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .map((record) => `${record.name}:${record.port}`)
    .join(",");

  const txtRecords = await dnsPromises.resolveTxt(host).catch(() => []);
  const txtParams = parseAtlasTxtOptions(txtRecords);
  const finalParams = new URLSearchParams(parsed.search || "");

  for (const [key, value] of txtParams.entries()) {
    if (!finalParams.has(key)) finalParams.set(key, value);
  }
  if (!finalParams.has("tls")) finalParams.set("tls", "true");

  const username = parsed.username ? encodeURIComponent(parsed.username) : "";
  const password = parsed.password ? encodeURIComponent(parsed.password) : "";
  const auth =
    username || password ? `${username}${password ? `:${password}` : ""}@` : "";
  const dbPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
  const query = finalParams.toString();

  return `mongodb://${auth}${hosts}${dbPath}${query ? `?${query}` : ""}`;
}

async function resolveDatabaseSelection(activeClient, explicitDbName, inferredDbName) {
  const requested = (explicitDbName || inferredDbName || "").trim();
  if (requested) {
    return {
      databaseName: requested,
      availableDatabases: [],
      source: explicitDbName ? "request" : "connectionString"
    };
  }

  let allNames = [];
  let filtered = [];
  try {
    const adminDb = activeClient.db("admin");
    const listed = await adminDb.command({ listDatabases: 1, nameOnly: true });
    allNames = (listed.databases || [])
      .map((item) => item.name)
      .filter((name) => typeof name === "string" && name.trim().length > 0);
    filtered = allNames.filter((name) => !SYSTEM_DATABASES.has(name));
  } catch (_err) {
    return { databaseName: "test", availableDatabases: [], source: "fallbackTestNoListPermission" };
  }

  if (filtered.length === 1) {
    return { databaseName: filtered[0], availableDatabases: filtered, source: "autoSingle" };
  }

  if (filtered.length > 1) {
    throw new Error(
      `Multiple databases found (${filtered.join(
        ", "
      )}). Please enter the exact Database Name to connect to your required dataset.`
    );
  }

  return { databaseName: "test", availableDatabases: allNames, source: "fallbackTest" };
}

app.get("/api/test", (_req, res) => {
  ok(res, "API working");
});

app.post("/api/connect", async (req, res) => {
  try {
    const { connectionString, dbName } = req.body || {};
    if (!connectionString) return fail(res, "Connection string required");
    if (!isValidMongoUri(connectionString)) {
      return fail(
        res,
        "Invalid MongoDB connection string. Use mongodb:// (local/Compass) or mongodb+srv:// (Atlas)."
      );
    }

    if (client) await client.close();

    try {
      client = await connectClient(connectionString);
    } catch (err) {
      if (!(isSrvConnection(connectionString) && isDnsSrvError(err))) {
        throw err;
      }

      dns.setServers(PUBLIC_DNS_SERVERS);
      try {
        client = await connectClient(connectionString);
      } catch (retryErr) {
        if (!isDnsSrvError(retryErr)) throw retryErr;
        const standardUri = await toStandardMongoUriFromSrv(connectionString);
        client = await connectClient(standardUri);
      }
    }

    const inferredDbName = getDbNameFromConnectionString(connectionString);
    const selection = await resolveDatabaseSelection(client, dbName, inferredDbName);
    const selectedDbName = selection.databaseName;
    db = client.db(selectedDbName);
    const collections = await db.listCollections().toArray();
    ok(res, {
      database: db.databaseName,
      collectionsCount: collections.length,
      availableDatabases: selection.availableDatabases,
      databaseSelectionSource: selection.source
    });
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch (_closeErr) {
        // ignore close errors after failed connect attempts
      }
    }
    client = null;
    db = null;
    fail(res, mapMongoConnectionError(err));
  }
});

app.post("/api/disconnect", async (_req, res) => {
  try {
    if (client) await client.close();
    client = null;
    db = null;
    ok(res, { disconnected: true });
  } catch (err) {
    fail(res, err.message || "Disconnect failed");
  }
});

app.get("/api/collections", async (_req, res) => {
  try {
    if (!ensureDb(res)) return;
    const list = await db.listCollections().toArray();
    ok(res, list.map((c) => c.name));
  } catch (err) {
    fail(res, err.message);
  }
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    if (!ensureDb(res)) return;
    const collections = await db.listCollections().toArray();
    const dataCollections = collections.filter((item) => item.type === "collection");
    const overview = [];
    const counts = await Promise.all(
      dataCollections.map(async (item) => {
        const collection = db.collection(item.name);
        const count = await collection.countDocuments({});
        return { name: item.name, count };
      })
    );
    overview.push(...counts);
    const docs = overview.reduce((sum, item) => sum + item.count, 0);
    ok(res, {
      database: db.databaseName,
      collectionsCount: overview.length,
      totalDocuments: docs,
      overview
    });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/crud/create", async (req, res) => {
  try {
    const { collection, document } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!document || typeof document !== "object") {
      return fail(res, "A valid document object is required");
    }
    const result = await col.insertOne(document);
    ok(res, { insertedId: result.insertedId });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/crud/read", async (req, res) => {
  try {
    const { collection, filter = {}, sort = {}, limit = 25, page = 1 } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 500));
    const normalizedPage = Math.max(1, Number(page) || 1);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const cursor = col.find(filter).sort(sort).skip(skip).limit(normalizedLimit);
    const [items, total] = await Promise.all([cursor.toArray(), col.countDocuments(filter)]);
    ok(res, { items, total, page: normalizedPage, limit: normalizedLimit });
  } catch (err) {
    fail(res, err.message);
  }
});

app.put("/api/crud/update", async (req, res) => {
  try {
    const { collection, id, update } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!id) return fail(res, "Document id is required");
    if (!update || typeof update !== "object") {
      return fail(res, "Update object is required");
    }
    const result = await col.updateOne({ _id: new ObjectId(id) }, { $set: update });
    ok(res, { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
  } catch (err) {
    fail(res, err.message);
  }
});

app.delete("/api/crud/delete", async (req, res) => {
  try {
    const { collection, id } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!id) return fail(res, "Document id is required");
    const result = await col.deleteOne({ _id: new ObjectId(id) });
    ok(res, { deletedCount: result.deletedCount });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/aggregate", async (req, res) => {
  try {
    const { collection, pipeline } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!Array.isArray(pipeline)) return fail(res, "Pipeline must be an array");
    const items = await col.aggregate(pipeline).toArray();
    ok(res, { items });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/geospatial", async (req, res) => {
  try {
    const { collection, field = "location", lat, lng, radiusKm = 500, mode = "near" } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
      return fail(res, "Latitude and longitude are required");
    }

    const center = [Number(lng), Number(lat)];
    const radiusMeters = Number(radiusKm) * 1000;
    const query =
      mode === "within"
        ? {
            [field]: {
              $geoWithin: {
                $centerSphere: [center, radiusMeters / 6378100]
              }
            }
          }
        : {
            [field]: {
              $near: {
                $geometry: { type: "Point", coordinates: center },
                $maxDistance: radiusMeters
              }
            }
          };

    const items = await col.find(query).limit(200).toArray();
    ok(res, { items });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/index/create", async (req, res) => {
  try {
    const { collection, field, type = 1 } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!field) return fail(res, "Index field is required");

    const indexValue = type === "2dsphere" || type === "text" ? type : Number(type) || 1;
    const indexName = await col.createIndex({ [field]: indexValue });
    ok(res, { indexName });
  } catch (err) {
    fail(res, err.message);
  }
});

app.get("/api/index/list", async (req, res) => {
  try {
    const col = getCollection(res, req.query.collection);
    if (!col) return;
    const indexes = await col.indexes();
    ok(res, { indexes });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/explain", async (req, res) => {
  try {
    const { collection, filter = {}, sort = {} } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    const explain = await col.find(filter).sort(sort).limit(50).explain("executionStats");
    const stats = explain.executionStats || {};
    ok(res, {
      nReturned: stats.nReturned,
      totalDocsExamined: stats.totalDocsExamined,
      totalKeysExamined: stats.totalKeysExamined,
      executionTimeMillis: stats.executionTimeMillis,
      winningPlan: explain.queryPlanner ? explain.queryPlanner.winningPlan : null
    });
  } catch (err) {
    fail(res, err.message);
  }
});

app.post("/api/advanced/transaction", async (req, res) => {
  const session = client ? client.startSession() : null;
  try {
    const { collection, doc1 = {}, doc2 = {}, mode = "commit" } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!session) return fail(res, "No active MongoDB client");

    await session.withTransaction(async () => {
      await col.insertOne(doc1, { session });
      await col.insertOne(doc2, { session });
      if (mode === "rollback") {
        throw new Error("Rollback requested");
      }
    });

    ok(res, { committed: true });
  } catch (err) {
    fail(res, err.message);
  } finally {
    if (session) await session.endSession();
  }
});

app.post("/api/advanced/concurrent", async (req, res) => {
  try {
    const { collection, id, field, count = 10 } = req.body || {};
    const col = getCollection(res, collection);
    if (!col) return;
    if (!id || !field) return fail(res, "id and field are required");

    const iterations = Math.max(1, Math.min(Number(count) || 10, 100));
    const _id = new ObjectId(id);
    await Promise.all(
      Array.from({ length: iterations }, () => col.updateOne({ _id }, { $inc: { [field]: 1 } }))
    );
    const updated = await col.findOne({ _id });
    ok(res, { updated, operations: iterations });
  } catch (err) {
    fail(res, err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});