const { MongoClient, ObjectId } = require("mongodb");

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/coverStock";
const authorityEnd = uri.indexOf("/", uri.indexOf("://") + 3);
const databaseName =
  (authorityEnd >= 0 ? uri.slice(authorityEnd + 1).split("?")[0] : "") ||
  "coverstock";
const client = new MongoClient(uri);
let connectPromise;
const {
  canonicalDevice,
  normalizeDevicePart,
  uniqueNames,
} = require("./deviceIdentity");

const coverModelKey = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
const canonicalDeviceName = (device: any) =>
  `${String(device.brand || "").trim()} ${String(device.model || "").trim()}`.trim();
const uniqueModelNames = (values: unknown[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = coverModelKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const sameModelNames = (left: unknown[], right: unknown[]) => {
  const leftKeys = uniqueModelNames(left).map(coverModelKey).sort();
  const rightKeys = uniqueModelNames(right).map(coverModelKey).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
};

// A compatibility group means the very same physical cover fits every member.
// Covers are therefore one shared stock record per group, rather than a
// separate balance for each phone name.
async function consolidateCompatibilityGroupStock(
  db: any,
  groupId: string,
  knownMembers?: any[],
) {
  const members =
    knownMembers ||
    (await db
      .collection("devices")
      .find({ status: { $ne: "archived" }, coverCompatibilityGroup: groupId })
      .toArray());
  const names = uniqueModelNames(members.map(canonicalDeviceName));
  if (!names.length) return null;
  const nameKeys = new Set(names.map(coverModelKey));
  const covers = (await db
    .collection("covers")
    .find({ status: "active", compatibleModels: { $exists: true } })
    .toArray()).filter((cover: any) =>
    (cover.compatibleModels || []).some((model: unknown) =>
      nameKeys.has(coverModelKey(model)),
    ),
  );
  if (!covers.length) return null;

  const compatibleModels = uniqueModelNames([
    ...names,
    ...covers.flatMap((cover: any) => cover.compatibleModels || []),
  ]);
  if (covers.length === 1) {
    const [cover] = covers;
    if (
      cover.coverCompatibilityGroup !== groupId ||
      !sameModelNames(cover.compatibleModels || [], compatibleModels)
    )
      await db.collection("covers").updateOne(
        { _id: cover._id },
        {
          $set: {
            coverCompatibilityGroup: groupId,
            compatibleModels,
            updatedAt: new Date(),
          },
        },
      );
    return cover._id;
  }

  const ordered = [...covers].sort((left, right) => {
    const byCreatedAt =
      new Date(left.createdAt || 0).getTime() -
      new Date(right.createdAt || 0).getTime();
    return byCreatedAt || left._id.toString().localeCompare(right._id.toString());
  });
  const canonical = ordered[0];
  const quantityOnHand = covers.reduce(
    (total: number, cover: any) => total + Number(cover.quantityOnHand || 0),
    0,
  );
  const reorderThreshold = Math.max(
    ...covers.map((cover: any) => Math.max(0, Number(cover.reorderThreshold || 0))),
  );
  const activity = covers
    .flatMap((cover: any) => cover.activity || [])
    .map((item: any) => ({ ...item, _id: item._id || new ObjectId() }));
  const recordedDelta = activity.reduce(
    (total: number, item: any) => total + (Number.isInteger(item.quantityDelta) ? item.quantityDelta : 0),
    0,
  );
  const openingBalance = quantityOnHand - recordedDelta;
  if (openingBalance) {
    const earliest = ordered[0].createdAt || new Date();
    activity.push({
      _id: new ObjectId(),
      type: "opening_balance",
      quantityDelta: openingBalance,
      quantityBefore: 0,
      quantityAfter: openingBalance,
      reason: null,
      note: "Balance retained while compatible cover records were consolidated",
      actor: "System",
      createdAt: earliest,
    });
  }
  activity.sort((left: any, right: any) => {
    const byCreatedAt =
      new Date(left.createdAt || 0).getTime() -
      new Date(right.createdAt || 0).getTime();
    return byCreatedAt || left._id.toString().localeCompare(right._id.toString());
  });
  let balance = 0;
  const mergedActivity = activity.map((item: any) => {
    const quantityDelta = Number.isInteger(item.quantityDelta)
      ? item.quantityDelta
      : 0;
    const quantityBefore = balance;
    balance += quantityDelta;
    return { ...item, quantityDelta, quantityBefore, quantityAfter: balance };
  });
  const now = new Date();
  await db.collection("covers").updateOne(
    { _id: canonical._id },
    {
      $set: {
        quantityOnHand,
        reorderThreshold,
        compatibleModels,
        coverCompatibilityGroup: groupId,
        activity: mergedActivity,
        updatedAt: now,
      },
    },
  );
  await db.collection("covers").updateMany(
    { _id: { $in: ordered.slice(1).map((cover) => cover._id) } },
    {
      $set: {
        status: "archived",
        archivedAt: now,
        mergedIntoCoverId: canonical._id,
        mergedAt: now,
        updatedAt: now,
      },
      // The canonical record has the combined activity feed. Keep the source
      // events under a migration field to preserve audit data without making
      // them appear a second time in the global activity feed.
      $rename: { activity: "mergedActivity" },
    },
  );
  return canonical._id;
}

async function reconcileCompatibleCoverStock(db: any) {
  const members = await db
    .collection("devices")
    .find({ status: { $ne: "archived" }, coverCompatibilityGroup: { $type: "string" } })
    .toArray();
  const groups = new Map<string, any[]>();
  members.forEach((device: any) => {
    if (!device.coverCompatibilityGroup) return;
    groups.set(device.coverCompatibilityGroup, [
      ...(groups.get(device.coverCompatibilityGroup) || []),
      device,
    ]);
  });
  for (const [groupId, groupMembers] of groups)
    await consolidateCompatibilityGroupStock(db, groupId, groupMembers);
}

const coverModelsForDevice = (device: any, sourceModels: unknown[]) => {
  const identifiers = uniqueModelNames([
    canonicalDeviceName(device),
    device.model,
    ...(device.aliases || []),
  ]).map(coverModelKey);
  const belongsToDevice = (model: unknown) => {
    const key = coverModelKey(model);
    return identifiers.some(
      (identifier) => key === identifier || key.startsWith(`${identifier} (`),
    );
  };
  return uniqueModelNames([
    ...sourceModels.filter(belongsToDevice),
    canonicalDeviceName(device),
  ]);
};

// Unlinking is deliberately not a split calculation: stock history cannot tell
// us how many physical covers belong to each phone. The initiating device keeps
// the entire shared balance and the detached device starts at zero.
async function splitCompatibilityGroupStock(
  db: any,
  groupId: string,
  ownerDevice: any,
  detachedDevice: any,
  members: any[],
  actor = "System",
) {
  await consolidateCompatibilityGroupStock(db, groupId, members);
  const sharedCover = await db.collection("covers").findOne({
    status: "active",
    coverCompatibilityGroup: groupId,
  });
  if (!sharedCover) return null;

  const remainingMembers = members.filter(
    (member) => !member._id.equals(detachedDevice._id),
  );
  const detachedModels = coverModelsForDevice(
    detachedDevice,
    sharedCover.compatibleModels || [],
  );
  const detachedKeys = new Set(detachedModels.map(coverModelKey));
  const retainedModels = uniqueModelNames([
    ...(sharedCover.compatibleModels || []).filter(
      (model: unknown) => !detachedKeys.has(coverModelKey(model)),
    ),
    ...remainingMembers.map(canonicalDeviceName),
  ]);
  const now = new Date();
  const balance = Number(sharedCover.quantityOnHand || 0);
  const ownerName = canonicalDeviceName(ownerDevice);
  const detachedName = canonicalDeviceName(detachedDevice);
  const unlinkActivity = {
    _id: new ObjectId(),
    type: "compatibility_unlink",
    quantityDelta: 0,
    quantityBefore: balance,
    quantityAfter: balance,
    reason: null,
    note: `${ownerName} kept the shared stock; ${detachedName} started at 0.`,
    actor,
    createdAt: now,
  };
  const sharedUpdate: any = {
    $set: {
      compatibleModels: retainedModels,
      activity: [...(sharedCover.activity || []), unlinkActivity],
      updatedAt: now,
    },
  };
  if (remainingMembers.length <= 1)
    sharedUpdate.$unset = { coverCompatibilityGroup: "" };
  await db.collection("covers").updateOne(
    { _id: sharedCover._id },
    sharedUpdate,
  );
  const detachedCover = {
    quantityOnHand: 0,
    reorderThreshold: Math.max(0, Number(sharedCover.reorderThreshold || 0)),
    compatibleModels: detachedModels,
    status: "active",
    activity: [
      {
        ...unlinkActivity,
        _id: new ObjectId(),
        quantityBefore: 0,
        quantityAfter: 0,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.collection("covers").insertOne(detachedCover);
  return { retainedCoverId: sharedCover._id, detachedCoverId: inserted.insertedId };
}

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

const deviceQuality = (device: any) =>
  [
    device.images?.primary,
    device.images?.back,
    device.source?.externalId,
    device.specifications?.description,
    device.coverCompatibilityGroup,
  ].filter(Boolean).length;

// Older imports used a case-sensitive { brand, model } index. Reconcile those
// records before creating the normalized identity index. Aliases are retained
// so existing cover compatibility values continue to resolve to the survivor.
async function reconcileDeviceIdentities(db: any) {
  const devices = await db
    .collection("devices")
    .find({ status: { $ne: "archived" } })
    .toArray();
  const groups = new Map<string, any[]>();
  for (const device of devices) {
    const identity = canonicalDevice(device.brand, device.model);
    if (!identity.brandKey || !identity.modelKey) continue;
    const key = `${identity.brandKey}\u0000${identity.modelKey}`;
    groups.set(key, [...(groups.get(key) || []), device]);
  }

  const operations: any[] = [];
  const now = new Date();
  for (const matches of groups.values()) {
    const ordered = [...matches].sort((left, right) => {
      const qualityDifference = deviceQuality(right) - deviceQuality(left);
      return qualityDifference || left._id.toString().localeCompare(right._id.toString());
    });
    const canonical = ordered[0];
    const identity = canonicalDevice(canonical.brand, canonical.model);
    const compatibilityGroup =
      canonical.coverCompatibilityGroup ||
      ordered.find((device) => device.coverCompatibilityGroup)
        ?.coverCompatibilityGroup;
    const aliases = uniqueNames(
      ordered.flatMap((device) => [
        ...(device.aliases || []),
        device.model,
        `${device.brand} ${device.model}`,
      ]),
    ).filter(
      (name) =>
        normalizeDevicePart(name) !== identity.modelKey &&
        normalizeDevicePart(name) !==
          normalizeDevicePart(`${identity.brand} ${identity.model}`),
    );
    const imageSource = ordered.find(
      (device) => device.images?.primary || device.images?.back,
    );
    operations.push({
      updateOne: {
        filter: { _id: canonical._id },
        update: {
          $set: {
            ...identity,
            aliases,
            ...(compatibilityGroup ? { coverCompatibilityGroup: compatibilityGroup } : {}),
            ...(canonical.images || imageSource?.images
              ? {
                  images: {
                    ...(imageSource?.images || {}),
                    ...(canonical.images || {}),
                  },
                }
              : {}),
            updatedAt: now,
          },
        },
      },
    });
    for (const duplicate of ordered.slice(1)) {
      operations.push({
        updateOne: {
          filter: { _id: duplicate._id },
          update: {
            $set: {
              status: "archived",
              archivedAt: now,
              mergedInto: canonical._id,
              ...(duplicate.source ? { mergedSource: duplicate.source } : {}),
              updatedAt: now,
            },
            // A future provider sync must match the canonical identity, not
            // revive this archived source record and collide with its keys.
            $unset: {
              brandKey: "",
              modelKey: "",
              coverCompatibilityGroup: "",
              source: "",
            },
          },
        },
      });
    }
  }
  if (operations.length)
    await db.collection("devices").bulkWrite(operations, { ordered: true });
}

async function replaceLegacyDeviceIndex(db: any) {
  // The old unique display index allows Poco/POCO duplicates and also prevents
  // the survivor from being renamed while its duplicate is still present.
  const indexes = await db.collection("devices").indexes();
  const legacyIndex = indexes.find(
    (index: any) => index.name === "brand_1_model_1" && index.unique,
  );
  if (legacyIndex) await db.collection("devices").dropIndex(legacyIndex.name);
}

async function ensureIndexes() {
  const db = await getDatabase();
  await replaceLegacyDeviceIndex(db);
  await reconcileDeviceIdentities(db);
  await reconcileCompatibleCoverStock(db);
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
    db.collection("devices").createIndex(
      { brand: 1, model: 1 },
      { name: "device_display_sort" },
    ),
    db
      .collection("devices")
      .createIndex({ brandKey: 1, modelKey: 1 }, { unique: true, sparse: true }),
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

module.exports = {
  client,
  consolidateCompatibilityGroupStock,
  ensureIndexes,
  getDatabase,
  splitCompatibilityGroupStock,
};
