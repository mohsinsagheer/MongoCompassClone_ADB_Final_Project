const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dbController');

// Database connection
router.post('/connect', ctrl.connectDB);

// Metadata
router.get('/stats', ctrl.getStats);
router.get('/collections', ctrl.getCollections);
router.post('/schema', ctrl.getSchema);

// CRUD
router.post('/crud/create', ctrl.createDocument);
router.post('/crud/read', ctrl.readDocuments);
router.put('/crud/update', ctrl.updateDocument);
router.delete('/crud/delete', ctrl.deleteDocument);

// Aggregation
router.post('/aggregate', ctrl.aggregateQuery);

// Geospatial
router.post('/geo/near', ctrl.geoNear);
router.post('/geo/within', ctrl.geoWithin);

// Indexes
router.post('/index/create', ctrl.createIndex);
router.post('/index/list', ctrl.listIndexes);
router.post('/index/drop', ctrl.dropIndex);

// Explain
router.post('/explain', ctrl.explainQuery);

// Transactions & Concurrency
router.post('/transaction', ctrl.runTransaction);
router.post('/atomic', ctrl.atomicUpdate);

module.exports = router;