import '../config/env.js';
import mongoose from 'mongoose';
import Order, { ORDER_FINGERPRINT_INDEX_NAME as INDEX_NAME } from '../models/Order.js';
import { connectDatabase, closeDatabase } from '../services/database.service.js';

const INDEX_KEY = { fingerprint: 1 };
const INDEX_OPTIONS = {
  name: INDEX_NAME,
  unique: true,
  partialFilterExpression: {
    fingerprint: { $gt: '' },
    status: 'INITIALIZED',
  },
};

const apply = process.argv.includes('--apply');
const sameKey = (index) => JSON.stringify(index?.key || {}) === JSON.stringify(INDEX_KEY);

function describeIndex(index) {
  return {
    name: index.name,
    key: index.key,
    unique: Boolean(index.unique),
    partialFilterExpression: index.partialFilterExpression || null,
  };
}

async function duplicateGroups() {
  return Order.aggregate([
    { $match: { fingerprint: { $gt: '' }, status: 'INITIALIZED' } },
    { $group: { _id: '$fingerprint', count: { $sum: 1 }, references: { $push: '$reference' } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);
}

async function main() {
  const connection = await connectDatabase();
  const collection = Order.collection;
  const indexes = await collection.indexes().catch(() => []);
  const fingerprintIndexes = indexes.filter(sameKey);
  const duplicates = await duplicateGroups();
  const orderCount = await Order.countDocuments();

  console.log(`MongoDB: ${connection.host}/${connection.name}`);
  console.log(`Orders: ${orderCount}`);
  console.log(`Fingerprint indexes: ${fingerprintIndexes.length ? JSON.stringify(fingerprintIndexes.map(describeIndex)) : 'none'}`);
  console.log(`Duplicate INITIALIZED fingerprints: ${duplicates.length}`);
  if (duplicates.length) {
    console.log(JSON.stringify(duplicates, null, 2));
    throw new Error('Duplicate active fingerprints exist; resolve them before creating the unique index.');
  }

  if (fingerprintIndexes.length) {
    const current = fingerprintIndexes[0];
    const compatible = current.unique === true
      && current.partialFilterExpression?.status === 'INITIALIZED'
      && current.partialFilterExpression?.fingerprint?.$gt === '';
    if (!compatible) {
      throw new Error(`An incompatible fingerprint index already exists: ${JSON.stringify(describeIndex(current))}. Refusing to drop it automatically.`);
    }
    console.log('Fingerprint index already exists and matches the required spec; no change needed.');
    return;
  }

  if (!apply) {
    console.log(`Dry run: would create ${INDEX_NAME} ${JSON.stringify(INDEX_KEY)} ${JSON.stringify(INDEX_OPTIONS)}.`);
    console.log('Re-run with --apply to create it.');
    return;
  }

  await collection.createIndex(INDEX_KEY, INDEX_OPTIONS);
  console.log(`Created ${INDEX_NAME}.`);
}

main()
  .catch((error) => {
    console.error(`Order index migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  });
