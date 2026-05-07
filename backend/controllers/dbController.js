const { ObjectId } = require('mongodb');

// Helpers to access shared connection from Express app locals
const getDb = (req) => req.app.locals.db;
const getClient = (req) => req.app.locals.dbClient;

// Require DB connection middleware — returns 401 if not connected
const requireDb = (req, res, next) => {
  if (!req.app.locals.db) {
    return res.status(401).json({ success: false, error: 'Not connected to a database. Please connect first.' });
  }
  next();
};

// Wrap async handlers to catch errors
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Connection ────────────────────────────────────────────────
exports.connectDB = asyncHandler(async (req, res) => {
  const { connectionString } = req.body;
  if (!connectionString) {
    return res.status(400).json({ success: false, error: 'Connection string is required.' });
  }

  // Close existing connection if any
  if (req.app.locals.dbClient) {
    try { await req.app.locals.dbClient.close(); } catch (_) {}
  }

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000
  });

  await client.connect();
  const db = client.db(); // Uses the database specified in the connection string

  req.app.locals.dbClient = client;
  req.app.locals.db = db;

  // Test the connection by listing collections
  const collections = await db.listCollections().toArray();

  res.json({
    success: true,
    message: 'Connected successfully',
    database: db.databaseName,
    collectionsCount: collections.length
  });
});

// ─── Metadata ──────────────────────────────────────────────────
exports.getStats = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const collections = await db.listCollections().toArray();
  const collectionStats = [];

  for (const col of collections) {
    let count = 0;
    let size = 0;
    try {
      const stats = await db.collection(col.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      count = stats[0]?.storageStats?.count || 0;
      size = stats[0]?.storageStats?.size || 0;
    } catch (_) {
      count = await db.collection(col.name).estimatedDocumentCount();
    }
    collectionStats.push({ name: col.name, count, size });
  }

  const totalDocs = collectionStats.reduce((s, c) => s + c.count, 0);
  const totalSize = collectionStats.reduce((s, c) => s + c.size, 0);

  res.json({
    success: true,
    data: {
      databaseName: db.databaseName,
      totalCollections: collections.length,
      totalDocuments: totalDocs,
      totalSizeBytes: totalSize,
      collections: collectionStats
    }
  });
});

exports.getCollections = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const collections = await db.listCollections().toArray();
  res.json({ success: true, data: collections.map(c => c.name) });
});

exports.getSchema = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection } = req.body;
  const sample = await db.collection(collection).findOne();
  if (!sample) return res.json({ success: true, data: null });

  // Grab a few more samples to detect varying types
  const samples = await db.collection(collection).find({}).limit(5).toArray();
  const fieldMap = {};

  for (const doc of samples) {
    for (const [key, val] of Object.entries(doc)) {
      if (!fieldMap[key]) {
        fieldMap[key] = new Set();
      }
      if (val === null) {
        fieldMap[key].add('null');
      } else if (Array.isArray(val)) {
        fieldMap[key].add('array');
      } else if (val.type === 'Point' || (val.coordinates && val.type)) {
        fieldMap[key].add('geojson');
      } else {
        fieldMap[key].add(typeof val);
      }
    }
  }

  const fields = Object.entries(fieldMap).map(([name, types]) => ({
    name,
    types: [...types],
    sample: sample[name]
  }));

  res.json({ success: true, data: fields });
});

// ─── CRUD ──────────────────────────────────────────────────────
exports.createDocument = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, document } = req.body;
  const result = await db.collection(collection).insertOne(document);
  res.json({ success: true, data: { insertedId: result.insertedId } });
});

exports.readDocuments = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, filter = {}, page = 1, limit = 25, sort = {} } = req.body;
  const skip = (Math.max(1, page) - 1) * Math.max(1, limit);

  const [documents, total] = await Promise.all([
    db.collection(collection).find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    db.collection(collection).countDocuments(filter)
  ]);

  res.json({
    success: true,
    data: {
      documents,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit)
    }
  });
});

exports.updateDocument = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, id, update } = req.body;
  const result = await db.collection(collection).updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
  res.json({ success: true, data: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } });
});

exports.deleteDocument = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, id } = req.body;
  const result = await db.collection(collection).deleteOne({ _id: new ObjectId(id) });
  res.json({ success: true, data: { deletedCount: result.deletedCount } });
});

// ─── Aggregation ───────────────────────────────────────────────
exports.aggregateQuery = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, pipeline } = req.body;
  const result = await db.collection(collection).aggregate(pipeline, { allowDiskUse: true }).toArray();
  res.json({ success: true, data: result });
});

// ─── Geospatial ────────────────────────────────────────────────
exports.geoNear = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, locationField, coordinates, maxDistance, limit = 50 } = req.body;

  const pipeline = [
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [Number(coordinates.lng), Number(coordinates.lat)] },
        distanceField: 'calculatedDistance',
        key: locationField,
        maxDistance: Number(maxDistance) * 1000, // km → meters
        spherical: true,
        limit: Number(limit)
      }
    }
  ];

  const result = await db.collection(collection).aggregate(pipeline).toArray();
  res.json({ success: true, data: result });
});

exports.geoWithin = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, locationField, coordinates, radius, limit = 100 } = req.body;

  // radius in km → convert to radians: radius / 6378.1
  const radiusRad = Number(radius) / 6378.1;

  const filter = {
    [locationField]: {
      $geoWithin: {
        $centerSphere: [[Number(coordinates.lng), Number(coordinates.lat)], radiusRad]
      }
    }
  };

  const result = await db.collection(collection).find(filter).limit(Number(limit)).toArray();
  res.json({ success: true, data: result });
});

// ─── Indexes ───────────────────────────────────────────────────
exports.createIndex = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, indexSpec, options = {} } = req.body;
  const indexName = await db.collection(collection).createIndex(indexSpec, options);
  res.json({ success: true, data: { indexName } });
});

exports.listIndexes = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection } = req.body;
  const indexes = await db.collection(collection).indexes();
  res.json({ success: true, data: indexes });
});

exports.dropIndex = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, indexName } = req.body;
  const result = await db.collection(collection).dropIndex(indexName);
  res.json({ success: true, data: result });
});

// ─── Explain ───────────────────────────────────────────────────
exports.explainQuery = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, filter = {}, pipeline, sort = {} } = req.body;

  let result;
  if (pipeline && pipeline.length > 0) {
    result = await db.collection(collection).aggregate(pipeline).explain('executionStats');
  } else {
    result = await db.collection(collection).find(filter).sort(sort).explain('executionStats');
  }

  res.json({ success: true, data: result });
});

// ─── Transactions ──────────────────────────────────────────────
exports.runTransaction = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const client = getClient(req);
  const db = getDb(req);
  const { collection, operations, action } = req.body; // action: 'commit' | 'rollback'

  const session = client.startSession();
  try {
    session.startTransaction();
    const results = [];

    for (const op of operations) {
      let r;
      switch (op.type) {
        case 'insert':
          r = await db.collection(collection).insertOne(op.document, { session });
          results.push({ type: 'insert', insertedId: r.insertedId });
          break;
        case 'update':
          r = await db.collection(collection).updateOne(
            { _id: new ObjectId(op.id) },
            { $set: op.update },
            { session }
          );
          results.push({ type: 'update', matchedCount: r.matchedCount, modifiedCount: r.modifiedCount });
          break;
        case 'delete':
          r = await db.collection(collection).deleteOne({ _id: new ObjectId(op.id) }, { session });
          results.push({ type: 'delete', deletedCount: r.deletedCount });
          break;
      }
    }

    if (action === 'commit') {
      await session.commitTransaction();
    } else {
      await session.abortTransaction();
    }

    res.json({ success: true, data: { action, results } });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
});

// ─── Atomic Updates ────────────────────────────────────────────
exports.atomicUpdate = asyncHandler(async (req, res) => {
  requireDb(req, res);
  const db = getDb(req);
  const { collection, id, field, increment } = req.body;

  const result = await db.collection(collection).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $inc: { [field]: Number(increment) } },
    { returnDocument: 'after' }
  );

  res.json({ success: true, data: result });
});