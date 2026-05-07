const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

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

app.get("/api/test", (_req, res) => {
  ok(res, "API working");
});

app.post("/api/connect", async (req, res) => {
  try {
    const { connectionString, dbName } = req.body || {};
    if (!connectionString) return fail(res, "Connection string required");

    if (client) await client.close();
    client = new MongoClient(connectionString.trim());
    await client.connect();

    db = dbName ? client.db(dbName) : client.db();
    const collections = await db.listCollections().toArray();
    ok(res, {
      database: db.databaseName,
      collectionsCount: collections.length
    });
  } catch (err) {
    fail(res, err.message || "Failed to connect");
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
    const overview = [];
    for (const item of collections) {
      const collection = db.collection(item.name);
      const count = await collection.estimatedDocumentCount();
      overview.push({ name: item.name, count });
    }
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