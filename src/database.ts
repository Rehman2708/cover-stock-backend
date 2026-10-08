const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/coverStock";
const authorityEnd = uri.indexOf("/", uri.indexOf("://") + 3);
const databaseName =
  (authorityEnd >= 0 ? uri.slice(authorityEnd + 1).split("?")[0] : "") ||
  "coverstock";
const client = new MongoClient(uri);
let connectPromise;

async function getDatabase() {
  if (!connectPromise) {
    connectPromise = client.connect().catch((error) => {
      connectPromise = undefined;
      throw error;
    });
  }
  await connectPromise;
  return client.db(databaseName);
}

async function ensureIndexes() {
  const db = await getDatabase();
  await Promise.all([
    db
      .collection("covers")
      .createIndex({ sku: 1 }, { unique: true, sparse: true }),
    db.collection("covers").createIndex({
      name: "text",
      sku: "text",
      barcode: "text",
      compatibleModels: "text",
    }),
    db.collection("transactions").createIndex({ coverId: 1, createdAt: -1 }),
    db.collection("transactions").createIndex({ createdAt: -1 }),
    db
      .collection("devices")
      .createIndex({ brand: 1, model: 1 }, { unique: true }),
    db
      .collection("devices")
      .createIndex(
        { "source.provider": 1, "source.externalId": 1 },
        { unique: true, sparse: true },
      ),
    db
      .collection("devices")
      .createIndex({ coverCompatibilityGroup: 1 }, { sparse: true }),
    db.collection("users").createIndex({ phone: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ token: 1 }, { unique: true }),
    db
      .collection("sessions")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

module.exports = { client, ensureIndexes, getDatabase };
