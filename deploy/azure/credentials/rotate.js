#!/usr/bin/env node
/**
 * Re-encrypts every MongoDB value LibreChat protects with CREDS_KEY/CREDS_IV, moving it from
 * OLD_CREDS_KEY/OLD_CREDS_IV to NEW_CREDS_KEY/NEW_CREDS_IV. Values already under the new pair are
 * skipped, so it is safe to re-run. DRY_RUN=true only classifies. No plaintext is ever logged.
 *
 * Registered stores (stores.js) fail the run on unreadable values; every other collection is
 * swept for v2/v3-shaped strings, rotating only those that verifiably decrypt with the old pair.
 * Exit codes: 0 ok, 1 unreadable/ambiguous values in registered stores, 2 fatal error.
 */
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { stores, sweepExclusions } = require('./stores');
const { codecs, validators, classify, readCredentialPair } = require('./codecs');

const DRY_RUN = process.env.DRY_RUN === 'true';
const MARKER_COLLECTION = 'librechatCredentialMetadata';
const MARKER_ID = 'primary';
const CREDENTIAL_NAMES = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'];
const SWEEP = { versions: ['v3', 'v2'], validate: 'text', strict: false };

const getPath = (doc, path) => path.split('.').reduce((node, key) => node?.[key], doc);

/** Yields every string leaf of a document as a dot-path Mongo can `$set` (array indices included). */
function* stringLeaves(node, prefix = '') {
  if (typeof node === 'string') {
    yield [prefix, node];
    return;
  }
  if (node == null || typeof node !== 'object' || node instanceof mongoose.mongo.ObjectId) {
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (prefix === '' && key === '_id') {
      continue;
    }
    yield* stringLeaves(child, prefix === '' ? key : `${prefix}.${key}`);
  }
}

function candidates(doc, store) {
  if (store.scan) {
    return [...stringLeaves(doc)];
  }
  return store.fields.map((path) => [path, getPath(doc, path)]);
}

const newTally = () => ({ documents: 0, rotated: 0, alreadyNew: 0, unreadable: 0, ambiguous: 0 });

async function rotateCollection(db, collection, store, creds) {
  const tally = newTally();
  const problems = [];
  const operations = [];
  const validate = validators[store.validate];
  const projection = store.scan
    ? undefined
    : Object.fromEntries(store.fields.map((path) => [path, 1]));

  for await (const doc of db.collection(collection).find({}, { projection })) {
    tally.documents++;
    const updates = {};
    const guards = {};
    for (const [path, value] of candidates(doc, store)) {
      const codec =
        typeof value === 'string' &&
        store.versions.map((v) => codecs[v]).find((c) => c.matches(value));
      if (!codec) {
        continue;
      }
      const result = classify(codec, value, validate, creds);
      if (result.state === 'new') {
        tally.alreadyNew++;
        continue;
      }
      if (result.state !== 'old') {
        tally[result.state]++;
        if (store.strict !== false) {
          problems.push({ collection, id: String(doc._id), path, state: result.state });
        }
        continue;
      }
      const rotated = codec.encrypt(creds.new, result.plaintext);
      if (codec.decrypt(creds.new, rotated) !== result.plaintext) {
        throw new Error(`Round-trip check failed for ${collection} ${doc._id} ${path}`);
      }
      updates[path] = rotated;
      guards[path] = value;
      tally.rotated++;
    }
    if (Object.keys(updates).length > 0) {
      operations.push({
        updateOne: { filter: { _id: doc._id, ...guards }, update: { $set: updates } },
      });
    }
  }

  if (!DRY_RUN && operations.length > 0) {
    const { matchedCount } = await db
      .collection(collection)
      .bulkWrite(operations, { ordered: false });
    if (matchedCount !== operations.length) {
      throw new Error(
        `${collection}: ${operations.length - matchedCount} documents changed mid-run; re-run`,
      );
    }
  }
  return { tally, problems };
}

const fingerprint = (value) =>
  crypto
    .createHash('sha256')
    .update(value ?? '')
    .digest('hex');

/** Records LibreChat's key-drift marker for the new credentials, never overwriting an existing one. */
async function recordCredentialMarker(db) {
  const env = {
    ...process.env,
    CREDS_KEY: process.env.NEW_CREDS_KEY,
    CREDS_IV: process.env.NEW_CREDS_IV,
  };
  const fingerprints = Object.fromEntries(
    CREDENTIAL_NAMES.map((name) => [name, fingerprint(env[name])]),
  );
  const { upsertedCount } = await db
    .collection(MARKER_COLLECTION)
    .updateOne(
      { _id: MARKER_ID },
      { $setOnInsert: { _id: MARKER_ID, fingerprints, createdAt: new Date() } },
      { upsert: true },
    );
  return upsertedCount === 1 ? 'recorded' : 'kept existing';
}

async function main() {
  const creds = { old: readCredentialPair('OLD_'), new: readCredentialPair('NEW_') };
  if (creds.old.key.equals(creds.new.key) || creds.old.iv.equals(creds.new.iv)) {
    throw new Error('NEW_CREDS_KEY and NEW_CREDS_IV must both differ from the old values');
  }
  if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET are required for the credential marker');
  }

  await mongoose.connect(process.env.MONGO_URI);
  const { db } = mongoose.connection;
  const registered = new Set(stores.map((store) => store.collection));
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  const sweep = existing.filter(
    (name) => !registered.has(name) && !sweepExclusions.has(name) && !name.startsWith('system.'),
  );

  const summary = {};
  const problems = [];
  const plan = [
    ...stores
      .filter((store) => existing.includes(store.collection))
      .map((store) => [store.collection, store]),
    ...sweep.map((name) => [name, { ...SWEEP, scan: true }]),
  ];
  for (const [collection, store] of plan) {
    const result = await rotateCollection(db, collection, store, creds);
    if (
      result.tally.rotated +
        result.tally.alreadyNew +
        result.tally.unreadable +
        result.tally.ambiguous >
      0
    ) {
      summary[collection] = { ...result.tally, strict: store.strict !== false };
    }
    problems.push(...result.problems);
  }

  const blocked = problems.length > 0;
  const marker = DRY_RUN || blocked ? 'skipped' : await recordCredentialMarker(db);
  console.log(
    JSON.stringify({ dryRun: DRY_RUN, scanned: plan.length, marker, summary, problems }, null, 2),
  );
  await mongoose.disconnect();
  process.exitCode = blocked ? 1 : 0;
}

main().catch(async (error) => {
  console.error(`[rotate] ${error.message}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 2;
});
