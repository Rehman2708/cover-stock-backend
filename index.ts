require("dotenv").config();

const express = require("express");
const { ObjectId } = require("mongodb");
const { randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const {
  consolidateCompatibilityGroupStock,
  ensureIndexes,
  getDatabase,
  removeDeletedDeviceFromCompatibilityStock,
  splitCompatibilityGroupStock,
} = require("./src/database");
const { canonicalDevice } = require("./src/deviceIdentity");
const {
  fuzzySearchPattern,
  sortDevicesBySearchMatch,
} = require("./src/searchRanking");

const app = express();
const port = Number(process.env.PORT || 3000);

// Keep this probe intentionally bodyless: Render and external uptime jobs only
// need a successful status code, and some monitors cap captured response sizes.
app.get("/health", (_, response) => response.status(204).end());

app.use(express.json());
app.use((_, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  next();
});
app.options("/{*splat}", (_, response) => response.sendStatus(204));

const serialize = (document) => {
  if (!document) return document;
  const { _id, activity, ...rest } = document;
  return { id: _id.toString(), ...rest };
};
const invalidId = (id) => !ObjectId.isValid(id);
const validImageUrl = (value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};
const route = (handler) => async (request, response, next) => {
  try {
    await handler(request, response);
  } catch (error) {
    next(error);
  }
};
const normalizePhone = (value) => String(value || "").replace(/\D/g, "");
const validPhoneInput = (value) => {
  const raw = String(value || "").trim();
  const phone = normalizePhone(raw);
  return (
    /^\+?[\d\s().-]+$/.test(raw) && phone.length >= 8 && phone.length <= 15
  );
};
const passwordValidationError = (
  password,
  { forRegistration = false } = {},
) => {
  if (!password) return "Enter your password.";
  if (password.length < 6) return "Password must be at least 6 characters.";
  if (password.length > 128) return "Password must be 128 characters or fewer.";
  if (
    forRegistration &&
    (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
  )
    return "Password must be at least 8 characters and include a letter and a number.";
  return null;
};
const passwordHash = (password, salt = randomBytes(16).toString("hex")) =>
  `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const validPassword = (password, savedHash) => {
  const [salt, hash] = String(savedHash || "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const publicUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  phone: user.phone,
});
async function createSession(db, user) {
  const token = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 1000 * 60 * 60 * 24 * 30);
  await db
    .collection("sessions")
    .insertOne({ token, userId: user._id, createdAt, expiresAt });
  return { token, user: publicUser(user) };
}
const authenticated = (handler) =>
  route(async (request, response) => {
    const token = String(request.headers.authorization || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token)
      return response
        .status(401)
        .json({ error: "Please log in to update availability." });
    const db = await getDatabase();
    const session = await db
      .collection("sessions")
      .findOne({ token, expiresAt: { $gt: new Date() } });
    if (!session)
      return response
        .status(401)
        .json({ error: "Your session has expired. Please log in again." });
    const user = await db.collection("users").findOne({ _id: session.userId });
    if (!user)
      return response
        .status(401)
        .json({ error: "Your account is no longer available." });
    request.user = user;
    await handler(request, response);
  });
const activityProjection = {
  coverId: 1,
  type: 1,
  quantityDelta: 1,
  quantityBefore: 1,
  quantityAfter: 1,
  reason: 1,
  note: 1,
  actor: 1,
  createdAt: 1,
  compatibleModels: "$cover.compatibleModels",
};
async function readActivityWithBalances(db, match: any = {}) {
  const legacyTransactions = await db
    .collection("transactions")
    .aggregate([
      { $match: match },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $lookup: {
          from: "covers",
          localField: "coverId",
          foreignField: "_id",
          as: "cover",
        },
      },
      { $unwind: { path: "$cover", preserveNullAndEmptyArrays: true } },
      { $project: activityProjection },
    ])
    .toArray();
  const coverMatch = match.coverId ? { _id: match.coverId } : {};
  const embeddedTransactions = await db
    .collection("covers")
    .aggregate([
      { $match: { ...coverMatch, activity: { $exists: true, $ne: [] } } },
      { $unwind: "$activity" },
      {
        $project: {
          _id: "$activity._id",
          coverId: "$_id",
          type: "$activity.type",
          quantityDelta: "$activity.quantityDelta",
          quantityBefore: "$activity.quantityBefore",
          quantityAfter: "$activity.quantityAfter",
          reason: "$activity.reason",
          note: "$activity.note",
          actor: "$activity.actor",
          createdAt: "$activity.createdAt",
          compatibleModels: "$compatibleModels",
        },
      },
    ])
    .toArray();
  const transactions = [...legacyTransactions, ...embeddedTransactions].sort(
    (a, b) => {
      const dateDifference =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return dateDifference || a._id.toString().localeCompare(b._id.toString());
    },
  );
  const balances = new Map();
  return transactions.map((transaction) => {
    const coverKey = transaction.coverId?.toString() || "";
    const fallbackBefore = balances.get(coverKey) || 0;
    const quantityBefore = Number.isInteger(transaction.quantityBefore)
      ? transaction.quantityBefore
      : fallbackBefore;
    const quantityAfter = Number.isInteger(transaction.quantityAfter)
      ? transaction.quantityAfter
      : quantityBefore + transaction.quantityDelta;
    balances.set(coverKey, quantityAfter);
    return { ...transaction, quantityBefore, quantityAfter };
  });
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const safeLimit = (value, fallback = 50, maximum = 100) =>
  Math.min(
    Math.max(Number.parseInt(String(value), 10) || fallback, 1),
    maximum,
  );
const canonicalDeviceName = (device) =>
  `${String(device.brand || "").trim()} ${String(device.model || "").trim()}`.trim();
const deviceNames = (device, familyDevices) => {
  const related = device.coverCompatibilityGroup
    ? familyDevices.filter(
        (item) =>
          item.coverCompatibilityGroup === device.coverCompatibilityGroup,
      )
    : [device];
  // A model name alone is not an identifier: both Oppo and Samsung sell an
  // A55. Covers use the brand-qualified name; confirmed shared covers use a
  // coverCompatibilityGroup instead.
  return [...new Set(related.map(canonicalDeviceName).filter(Boolean))];
};
const compatibilityKey = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
const displayDevice = (device) => ({
  id: device._id.toString(),
  brand: device.brand,
  model: device.model,
  images: device.images,
});
const compatibleFamilyDevices = (device, familyDevices) =>
  !device.coverCompatibilityGroup
    ? []
    : familyDevices
        .filter(
          (item) =>
            item.coverCompatibilityGroup === device.coverCompatibilityGroup &&
            !item._id.equals(device._id),
        )
        .map(displayDevice);
const compatibleCoverFilter = (names) => {
  const values = [...new Set(names.map(compatibilityKey).filter(Boolean))];
  if (!values.length) return { _id: { $exists: false } };
  return {
    status: "active",
    // Existing stock can have a different letter case from the device catalogue.
    // Match the whole model name so "A5" never accidentally matches "A55".
    $or: values.map((name) => ({
      compatibleModels: {
        $regex: `^${escapeRegex(name).replace(/\s+/g, "\\s+")}$`,
        $options: "i",
      },
    })),
  };
};
const findCompatibleCovers = (db, names) =>
  db.collection("covers").find(compatibleCoverFilter(names));

async function canonicalCompatibleModels(db, values) {
  const requested = [...new Set(values.map(compatibilityKey).filter(Boolean))];
  const devices = await db
    .collection("devices")
    .find(
      { status: { $ne: "archived" } },
      { projection: { brand: 1, model: 1 } },
    )
    .toArray();
  const byCanonicalName = new Map();
  const byModel = new Map();
  devices.forEach((device) => {
    const canonicalName = canonicalDeviceName(device);
    const canonicalKey = compatibilityKey(canonicalName);
    const modelKey = compatibilityKey(device.model);
    byCanonicalName.set(canonicalKey, canonicalName);
    byModel.set(modelKey, [...(byModel.get(modelKey) || []), canonicalName]);
  });

  const compatibleModels = [];
  const ambiguousModels = [];
  const unknownModels = [];
  requested.forEach((name) => {
    const canonicalName = byCanonicalName.get(name);
    if (canonicalName) return compatibleModels.push(canonicalName);
    const matchingDevices = byModel.get(name) || [];
    if (matchingDevices.length === 1)
      return compatibleModels.push(matchingDevices[0]);
    if (matchingDevices.length > 1) return ambiguousModels.push(name);
    unknownModels.push(name);
  });
  return {
    compatibleModels: [...new Set(compatibleModels)],
    ambiguousModels,
    unknownModels,
  };
}

async function attachDisplayDevices(db, covers, preferredQuery = "") {
  if (!covers.length) return covers;
  const devices = await db
    .collection("devices")
    .find(
      { status: { $ne: "archived" } },
      {
        projection: {
          brand: 1,
          model: 1,
          aliases: 1,
          images: 1,
          coverCompatibilityGroup: 1,
        },
      },
    )
    .sort({ brand: 1, model: 1, _id: 1 })
    .toArray();
  const byName = new Map();
  devices.forEach((device) => {
    const key = compatibilityKey(canonicalDeviceName(device));
    if (!key) return;
    byName.set(key, [...(byName.get(key) || []), device]);
  });
  return covers.map((cover) => {
    const directlyMatchedDevices = (cover.compatibleModels || []).flatMap(
      (name) => byName.get(compatibilityKey(name)) || [],
    );
    // A group is created only for models verified to use the same physical
    // cover. Once a cover matches one member, the customer-facing list should
    // include its complete verified family rather than only the stored name.
    const groupIds = new Set(
      directlyMatchedDevices
        .map((device) => device.coverCompatibilityGroup)
        .filter(Boolean),
    );
    const matchingDevices = [
      ...new Map(
        [
          ...directlyMatchedDevices,
          ...devices.filter((device) =>
            groupIds.has(device.coverCompatibilityGroup),
          ),
        ].map((device) => [device._id.toString(), device]),
      ).values(),
    ];
    const rankedDevices = sortDevicesBySearchMatch(
      matchingDevices,
      preferredQuery,
    );
    return rankedDevices.length
      ? {
          ...cover,
          displayDevice: displayDevice(rankedDevices[0]),
          compatibleDevices: rankedDevices.map(displayDevice),
        }
      : cover;
  });
}

async function mutateCoverStock(
  db,
  coverId,
  { type, delta, reason, note, actor = "Shop owner" },
) {
  const now = new Date();
  const activityId = new ObjectId();
  const updatedCover = await db.collection("covers").findOneAndUpdate(
    {
      _id: coverId,
      status: "active",
      quantityOnHand: { $gte: Math.max(0, -delta) },
    },
    [
      {
        $set: {
          quantityOnHand: { $add: ["$quantityOnHand", delta] },
          updatedAt: now,
          activity: {
            $concatArrays: [
              { $ifNull: ["$activity", []] },
              [
                {
                  _id: activityId,
                  type,
                  quantityDelta: delta,
                  quantityBefore: "$quantityOnHand",
                  quantityAfter: { $add: ["$quantityOnHand", delta] },
                  reason: reason || null,
                  note: note || null,
                  actor,
                  createdAt: now,
                },
              ],
            ],
          },
        },
      },
    ],
    { returnDocument: "after" },
  );
  if (!updatedCover) return null;
  const transaction = updatedCover.activity.find((item) =>
    item._id.equals(activityId),
  );
  return { cover: updatedCover, transaction: { ...transaction, coverId } };
}

app.get(
  "/api/health",
  route(async (_, response) => {
    const db = await getDatabase();
    await db.command({ ping: 1 });
    response.json({
      status: "ok",
      message: "Local MongoDB is connected.",
      timestamp: new Date().toISOString(),
    });
  }),
);

app.post(
  "/api/auth/register",
  route(async (request, response) => {
    const name = String(request.body?.name || "").trim();
    const phone = normalizePhone(request.body?.phone);
    const password = String(request.body?.password || "");
    if (name.length < 2)
      return response
        .status(400)
        .json({ error: "Name must be at least 2 characters." });
    if (name.length > 60)
      return response
        .status(400)
        .json({ error: "Name must be 60 characters or fewer." });
    if (!validPhoneInput(request.body?.phone))
      return response
        .status(400)
        .json({ error: "Enter a valid phone number with 8 to 15 digits." });
    const passwordError = passwordValidationError(password, {
      forRegistration: true,
    });
    if (passwordError)
      return response.status(400).json({ error: passwordError });
    const db = await getDatabase();
    const now = new Date();
    const user = {
      name,
      phone,
      passwordHash: passwordHash(password),
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await db.collection("users").insertOne(user);
    response
      .status(201)
      .json(await createSession(db, { _id: inserted.insertedId, ...user }));
  }),
);

app.post(
  "/api/auth/login",
  route(async (request, response) => {
    const phone = normalizePhone(request.body?.phone);
    const password = String(request.body?.password || "");
    if (!validPhoneInput(request.body?.phone))
      return response
        .status(400)
        .json({ error: "Enter a valid phone number with 8 to 15 digits." });
    const passwordError = passwordValidationError(password);
    if (passwordError)
      return response.status(400).json({ error: passwordError });
    const db = await getDatabase();
    const user = await db.collection("users").findOne({ phone });
    if (!user || !validPassword(password, user.passwordHash))
      return response
        .status(401)
        .json({ error: "Phone number or password is incorrect." });
    response.json(await createSession(db, user));
  }),
);

app.get(
  "/api/auth/me",
  authenticated(async (request, response) => {
    response.json(publicUser(request.user));
  }),
);

app.patch(
  "/api/auth/profile",
  authenticated(async (request, response) => {
    const name = String(request.body?.name || "").trim();
    if (name.length < 2)
      return response.status(400).json({ error: "Enter your name." });
    if (name.length > 60)
      return response
        .status(400)
        .json({ error: "Name must be 60 characters or fewer." });
    const db = await getDatabase();
    const updated = await db
      .collection("users")
      .findOneAndUpdate(
        { _id: request.user._id },
        { $set: { name, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
    response.json(publicUser(updated));
  }),
);

app.patch(
  "/api/auth/password",
  authenticated(async (request, response) => {
    const currentPassword = String(request.body?.currentPassword || "");
    const newPassword = String(request.body?.newPassword || "");
    if (!validPassword(currentPassword, request.user.passwordHash))
      return response
        .status(400)
        .json({ error: "Your current password is incorrect." });
    const passwordError = passwordValidationError(newPassword, {
      forRegistration: true,
    });
    if (passwordError)
      return response.status(400).json({ error: passwordError });
    const db = await getDatabase();
    await db.collection("users").updateOne(
      { _id: request.user._id },
      {
        $set: {
          passwordHash: passwordHash(newPassword),
          updatedAt: new Date(),
        },
      },
    );
    response.json({ message: "Password changed." });
  }),
);

app.get(
  "/api/covers",
  authenticated(async (request, response) => {
    const db = await getDatabase();
    const status = request.query.status;
    const stock = String(request.query.stock || "all");
    const sort = String(request.query.sort || "recent");
    const limit = safeLimit(request.query.limit, 50, 100);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const stockFilter =
      stock === "in_stock"
        ? { quantityOnHand: { $gt: 0 } }
        : stock === "attention"
          ? {
              $or: [
                { quantityOnHand: 0 },
                {
                  $expr: {
                    $and: [
                      { $gt: ["$quantityOnHand", 0] },
                      { $lte: ["$quantityOnHand", "$reorderThreshold"] },
                    ],
                  },
                },
              ],
            }
          : stock === "low_stock"
            ? {
                $expr: {
                  $and: [
                    { $gt: ["$quantityOnHand", 0] },
                    { $lte: ["$quantityOnHand", "$reorderThreshold"] },
                  ],
                },
              }
            : stock === "out_of_stock"
              ? { quantityOnHand: 0 }
              : {};
    const filter = {
      ...(status ? { status } : { status: { $ne: "archived" } }),
      ...stockFilter,
    };
    const coverSort =
      sort === "quantity_low"
        ? { quantityOnHand: 1, updatedAt: -1, _id: 1 }
        : sort === "quantity_high"
          ? { quantityOnHand: -1, updatedAt: -1, _id: 1 }
          : { updatedAt: -1, _id: 1 };
    const [covers, total] = await Promise.all([
      db
        .collection("covers")
        .find(filter)
        .sort(coverSort)
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
      db.collection("covers").countDocuments(filter),
    ]);
    const items = covers.slice(0, limit);
    response.json({
      items: (await attachDisplayDevices(db, items)).map(serialize),
      nextOffset: covers.length > limit ? offset + limit : null,
      total,
    });
  }),
);

app.get(
  "/api/covers/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid cover id." });
    const db = await getDatabase();
    const cover = await db
      .collection("covers")
      .findOne({ _id: new ObjectId(request.params.id), status: "active" });
    if (!cover) return response.status(404).json({ error: "Cover not found." });
    response.json(serialize((await attachDisplayDevices(db, [cover]))[0]));
  }),
);

app.post(
  "/api/covers",
  authenticated(async (request, response) => {
    const body = request.body || {};
    const requestedCompatibleModels = Array.isArray(body.compatibleModels)
      ? body.compatibleModels
          .map((model) => String(model || "").trim())
          .filter(Boolean)
      : [];
    if (!requestedCompatibleModels.length)
      return response
        .status(400)
        .json({ error: "Add at least one compatible phone model." });
    const db = await getDatabase();
    const { compatibleModels, ambiguousModels, unknownModels } =
      await canonicalCompatibleModels(db, requestedCompatibleModels);
    if (ambiguousModels.length)
      return response.status(400).json({
        error: `Specify the brand for ${ambiguousModels.join(", ")}; that model name is used by more than one phone.`,
      });
    if (unknownModels.length)
      return response.status(400).json({
        error: `Phone not found: ${unknownModels.join(", ")}. Choose a phone from the catalogue.`,
      });
    if (!compatibleModels.length)
      return response
        .status(400)
        .json({ error: "Add at least one compatible phone model." });
    const requestedNameKeys = new Set(compatibleModels.map(compatibilityKey));
    const selectedDevices = (
      await db
        .collection("devices")
        .find({ status: { $ne: "archived" } })
        .toArray()
    ).filter((device) =>
      requestedNameKeys.has(compatibilityKey(canonicalDeviceName(device))),
    );
    const compatibilityGroups = [
      ...new Set(
        selectedDevices
          .map((device) => device.coverCompatibilityGroup)
          .filter(Boolean),
      ),
    ];
    const coverCompatibilityGroup =
      compatibilityGroups.length === 1 ? compatibilityGroups[0] : undefined;
    const familyDevices = coverCompatibilityGroup
      ? await db
          .collection("devices")
          .find({
            status: { $ne: "archived" },
            coverCompatibilityGroup,
          })
          .toArray()
      : [];
    const coverModels = coverCompatibilityGroup
      ? [
          ...new Map(
            [
              ...compatibleModels,
              ...familyDevices.map(canonicalDeviceName),
            ].map((name) => [compatibilityKey(name), name]),
          ).values(),
        ]
      : compatibleModels;
    const startingQuantity = Number(body.startingQuantity || 0);
    if (!Number.isInteger(startingQuantity) || startingQuantity < 0)
      return response.status(400).json({
        error: "Starting quantity must be a whole number of zero or more.",
      });

    const now = new Date();
    const cover = {
      quantityOnHand: startingQuantity,
      reorderThreshold: Math.max(0, Number(body.reorderThreshold ?? 3)),
      compatibleModels: coverModels,
      ...(coverCompatibilityGroup ? { coverCompatibilityGroup } : {}),
      status: "active",
      activity:
        startingQuantity > 0
          ? [
              {
                _id: new ObjectId(),
                type: "opening_balance",
                quantityDelta: startingQuantity,
                quantityBefore: 0,
                quantityAfter: startingQuantity,
                reason: null,
                note: "Opening balance",
                actor: request.user.name,
                createdAt: now,
              },
            ]
          : [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("covers").insertOne(cover);
    const sharedCoverId = coverCompatibilityGroup
      ? await consolidateCompatibilityGroupStock(
          db,
          coverCompatibilityGroup,
          familyDevices,
        )
      : result.insertedId;
    const savedCover = await db
      .collection("covers")
      .findOne({ _id: sharedCoverId || result.insertedId });
    response
      .status(201)
      .json(
        serialize((await attachDisplayDevices(db, [savedCover || cover]))[0]),
      );
  }),
);

app.post(
  "/api/covers/:id/transactions",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid cover id." });
    const body = request.body || {};
    const type = String(body.type || "adjustment");
    const quantity = Number(body.quantity);
    const decreaseTypes = new Set(["sale", "damaged"]);
    const positiveTypes = new Set(["restock", "return", "opening_balance"]);
    const delta = decreaseTypes.has(type)
      ? -Math.abs(quantity)
      : positiveTypes.has(type)
        ? Math.abs(quantity)
        : Number(body.quantityDelta);
    if (!Number.isInteger(delta) || delta === 0)
      return response
        .status(400)
        .json({ error: "Quantity must be a non-zero whole number." });
    if (type === "adjustment" && !String(body.reason || "").trim())
      return response
        .status(400)
        .json({ error: "A reason is required for stock adjustments." });

    const db = await getDatabase();
    const coverId = new ObjectId(request.params.id);
    const cover = await db
      .collection("covers")
      .findOne({ _id: coverId, status: "active" });
    if (!cover) return response.status(404).json({ error: "Cover not found." });
    if (cover.quantityOnHand + delta < 0)
      return response.status(409).json({
        error: `Only ${cover.quantityOnHand} item(s) are currently in stock.`,
      });
    const result = await mutateCoverStock(db, coverId, {
      type,
      delta,
      reason: body.reason ? String(body.reason).trim() : null,
      note: body.note ? String(body.note).trim() : null,
      actor: request.user.name,
    });
    if (!result)
      return response
        .status(409)
        .json({ error: "Stock changed. Please try again." });
    response.status(201).json({
      cover: serialize((await attachDisplayDevices(db, [result.cover]))[0]),
      transaction: serialize({
        _id: result.transaction._id,
        ...result.transaction,
      }),
    });
  }),
);

app.get(
  "/api/covers/:id/transactions",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid cover id." });
    const db = await getDatabase();
    const transactions = await readActivityWithBalances(db, {
      coverId: new ObjectId(request.params.id),
    });
    response.json(transactions.reverse().map(serialize));
  }),
);

app.get(
  "/api/devices/brands",
  authenticated(async (_, response) => {
    const db = await getDatabase();
    const [devices, covers] = await Promise.all([
      db
        .collection("devices")
        .find(
          {
            status: { $ne: "archived" },
            brand: { $type: "string", $ne: "" },
          },
          { projection: { brand: 1, model: 1, coverCompatibilityGroup: 1 } },
        )
        .toArray(),
      db
        .collection("covers")
        .find(
          { status: "active", quantityOnHand: { $gt: 0 } },
          { projection: { compatibleModels: 1 } },
        )
        .toArray(),
    ]);
    const brandCounts = new Map();
    const devicesByName = new Map();
    const devicesByCompatibilityGroup = new Map();
    devices.forEach((device) => {
      brandCounts.set(device.brand, (brandCounts.get(device.brand) || 0) + 1);
      devicesByName.set(compatibilityKey(canonicalDeviceName(device)), device);
      if (device.coverCompatibilityGroup)
        devicesByCompatibilityGroup.set(device.coverCompatibilityGroup, [
          ...(devicesByCompatibilityGroup.get(device.coverCompatibilityGroup) ||
            []),
          device,
        ]);
    });
    const stockedDeviceIds = new Set();
    covers.forEach((cover) => {
      (cover.compatibleModels || []).forEach((model) => {
        const device = devicesByName.get(compatibilityKey(model));
        if (!device) return;
        const matchingDevices = device.coverCompatibilityGroup
          ? devicesByCompatibilityGroup.get(device.coverCompatibilityGroup) ||
            []
          : [device];
        matchingDevices.forEach((item) =>
          stockedDeviceIds.add(item._id.toString()),
        );
      });
    });
    const stockedModelCounts = new Map();
    devices.forEach((device) => {
      if (!stockedDeviceIds.has(device._id.toString())) return;
      stockedModelCounts.set(
        device.brand,
        (stockedModelCounts.get(device.brand) || 0) + 1,
      );
    });
    const brands = [...brandCounts.entries()]
      .map(([brand, modelCount]) => ({
        brand,
        modelCount,
        stockedModelCount: stockedModelCounts.get(brand) || 0,
        hasStock: stockedModelCounts.has(brand),
      }))
      .sort((left, right) => left.brand.localeCompare(right.brand));
    response.json(brands);
  }),
);

app.post(
  "/api/devices",
  authenticated(async (request, response) => {
    const { brand, model, brandKey, modelKey } = canonicalDevice(
      request.body?.brand,
      request.body?.model,
    );
    const imageUrl = String(request.body?.imageUrl || "").trim();
    if (brand.length < 2 || model.length < 1)
      return response.status(400).json({ error: "Enter a brand and model." });
    if (brand.length > 60 || model.length > 100)
      return response
        .status(400)
        .json({ error: "Brand or model is too long." });
    if (!validImageUrl(imageUrl))
      return response.status(400).json({ error: "Enter a valid image URL." });
    const db = await getDatabase();
    const existing = await db.collection("devices").findOne({
      $or: [
        { brandKey, modelKey },
        {
          brand: { $regex: `^${escapeRegex(brand)}$`, $options: "i" },
          model: { $regex: `^${escapeRegex(model)}$`, $options: "i" },
        },
      ],
    });
    if (existing?.status === "archived") {
      const restored = await db.collection("devices").findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            status: "active",
            brand,
            model,
            brandKey,
            modelKey,
            updatedAt: new Date(),
          },
          $unset: { archivedAt: "" },
        },
        { returnDocument: "after" },
      );
      return response.status(201).json(serialize(restored));
    }
    if (existing)
      return response.status(409).json({
        error: `${existing.brand} ${existing.model} is already in your catalogue.`,
      });
    const now = new Date();
    const device = {
      brand,
      model,
      brandKey,
      modelKey,
      aliases: [],
      images: imageUrl ? { primary: imageUrl } : {},
      source: "manual",
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await db.collection("devices").insertOne(device);
    response
      .status(201)
      .json(serialize({ _id: inserted.insertedId, ...device }));
  }),
);

app.patch(
  "/api/devices/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const { brand, model, brandKey, modelKey } = canonicalDevice(
      request.body?.brand,
      request.body?.model,
    );
    const hasImageUrl = Object.hasOwn(request.body || {}, "imageUrl");
    const imageUrl = hasImageUrl
      ? String(request.body.imageUrl || "").trim()
      : undefined;
    if (brand.length < 2 || model.length < 1)
      return response.status(400).json({ error: "Enter a brand and model." });
    if (brand.length > 60 || model.length > 100)
      return response
        .status(400)
        .json({ error: "Brand or model is too long." });
    if (hasImageUrl && !validImageUrl(imageUrl))
      return response.status(400).json({ error: "Enter a valid image URL." });

    const db = await getDatabase();
    const deviceId = new ObjectId(request.params.id);
    const device = await db.collection("devices").findOne({
      _id: deviceId,
      status: { $ne: "archived" },
    });
    if (!device)
      return response.status(404).json({ error: "Device not found." });
    const duplicate = await db.collection("devices").findOne({
      _id: { $ne: deviceId },
      status: { $ne: "archived" },
      $or: [
        { brandKey, modelKey },
        {
          brand: { $regex: `^${escapeRegex(brand)}$`, $options: "i" },
          model: { $regex: `^${escapeRegex(model)}$`, $options: "i" },
        },
      ],
    });
    if (duplicate)
      return response.status(409).json({
        error: `${duplicate.brand} ${duplicate.model} is already in your catalogue.`,
      });

    const aliases = [
      ...new Set([
        ...(device.aliases || []),
        device.model,
        `${device.brand} ${device.model}`,
      ]),
    ].filter((name) => name !== model && name !== `${brand} ${model}`);
    const updated = await db.collection("devices").findOneAndUpdate(
      { _id: deviceId },
      {
        $set: {
          brand,
          model,
          brandKey,
          modelKey,
          aliases,
          ...(hasImageUrl
            ? {
                images: { ...(device.images || {}), primary: imageUrl || null },
              }
            : {}),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    const oldNameKey = compatibilityKey(canonicalDeviceName(device));
    const newName = canonicalDeviceName({ brand, model });
    const coversToUpdate = (await db
      .collection("covers")
      .find({ status: "active", compatibleModels: { $exists: true } })
      .toArray()).filter((cover) =>
      (cover.compatibleModels || []).some(
        (name) => compatibilityKey(name) === oldNameKey,
      ),
    );
    if (coversToUpdate.length) {
      const now = new Date();
      await db.collection("covers").bulkWrite(
        coversToUpdate.map((cover) => {
          const seen = new Set();
          const compatibleModels = (cover.compatibleModels || []).reduce(
            (names, name) => {
              const value =
                compatibilityKey(name) === oldNameKey ? newName : name;
              const key = compatibilityKey(value);
              if (!key || seen.has(key)) return names;
              seen.add(key);
              names.push(value);
              return names;
            },
            [],
          );
          return {
            updateOne: {
              filter: { _id: cover._id, status: "active" },
              update: { $set: { compatibleModels, updatedAt: now } },
            },
          };
        }),
        { ordered: true },
      );
    }
    if (updated?.coverCompatibilityGroup) {
      const familyDevices = await db
        .collection("devices")
        .find({
          status: { $ne: "archived" },
          coverCompatibilityGroup: updated.coverCompatibilityGroup,
        })
        .toArray();
      await consolidateCompatibilityGroupStock(
        db,
        updated.coverCompatibilityGroup,
        familyDevices,
      );
    }
    response.json(serialize(updated));
  }),
);

app.get(
  "/api/devices",
  authenticated(async (request, response) => {
    const db = await getDatabase();
    const brand = String(request.query.brand || "").trim();
    const sort = String(request.query.sort || "model_asc");
    const requestedStock = String(request.query.stock || "all");
    const stock = ["all", "in_stock", "out_of_stock"].includes(
      requestedStock,
    )
      ? requestedStock
      : "all";
    const limit = safeLimit(request.query.limit, 50, 100);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const filter = {
      status: { $ne: "archived" },
      ...(brand ? { brand } : {}),
    };
    const deviceSort =
      sort === "model_desc"
        ? { brand: -1, model: -1, _id: -1 }
        : { brand: 1, model: 1, _id: 1 };
    if (stock !== "all") {
      // Inventory is calculated from compatible covers, including every member
      // of a compatibility group. Filter after that calculation so the result
      // matches the availability shown on each device card.
      const candidates = await db
        .collection("devices")
        .find(filter)
        .sort(deviceSort)
        .toArray();
      const compatibilityGroups = [
        ...new Set(
          candidates
            .map((device) => device.coverCompatibilityGroup)
            .filter(Boolean),
        ),
      ];
      const familyDevices = compatibilityGroups.length
        ? await db
            .collection("devices")
            .find({
              status: { $ne: "archived" },
              coverCompatibilityGroup: { $in: compatibilityGroups },
            })
            .toArray()
        : [];
      const names = [
        ...new Set(
          candidates.flatMap((device) => deviceNames(device, familyDevices)),
        ),
      ];
      const covers = names.length
        ? await findCompatibleCovers(db, names).toArray()
        : [];
      const matchingDevices = candidates
        .map((device) => {
          const compatibleNames = new Set(
            deviceNames(device, familyDevices).map(compatibilityKey),
          );
          const matchingCovers = covers.filter((cover) =>
            cover.compatibleModels?.some((model) =>
              compatibleNames.has(compatibilityKey(model)),
            ),
          );
          const inventory = {
            unitsOnHand: matchingCovers.reduce(
              (total, cover) => total + cover.quantityOnHand,
              0,
            ),
            coverVariants: matchingCovers.length,
          };
          return serialize({
            ...device,
            inventory,
            compatibleDevices: compatibleFamilyDevices(device, familyDevices),
          });
        })
        .filter((device) =>
          stock === "in_stock"
            ? device.inventory.unitsOnHand > 0
            : device.inventory.unitsOnHand === 0,
        );
      const items = matchingDevices.slice(offset, offset + limit);
      return response.json({
        items,
        nextOffset:
          matchingDevices.length > offset + limit ? offset + limit : null,
        total: matchingDevices.length,
      });
    }
    const [devices, total] = await Promise.all([
      db
        .collection("devices")
        .find(filter)
        .sort(deviceSort)
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
      db.collection("devices").countDocuments(filter),
    ]);
    const items = devices.slice(0, limit);
    const compatibilityGroups = [
      ...new Set(
        items.map((device) => device.coverCompatibilityGroup).filter(Boolean),
      ),
    ];
    const familyDevices = compatibilityGroups.length
      ? await db
          .collection("devices")
          .find({
            status: { $ne: "archived" },
            coverCompatibilityGroup: { $in: compatibilityGroups },
          })
          .toArray()
      : [];
    const names = [
      ...new Set(items.flatMap((device) => deviceNames(device, familyDevices))),
    ];
    const covers = names.length
      ? await findCompatibleCovers(db, names).toArray()
      : [];
    const serialized = items.map((device) => {
      const compatibleNames = new Set(
        deviceNames(device, familyDevices).map(compatibilityKey),
      );
      const matchingCovers = covers.filter((cover) =>
        cover.compatibleModels?.some((model) =>
          compatibleNames.has(compatibilityKey(model)),
        ),
      );
      const inventory = {
        unitsOnHand: matchingCovers.reduce(
          (total, cover) => total + cover.quantityOnHand,
          0,
        ),
        coverVariants: matchingCovers.length,
      };
      return serialize({
        ...device,
        inventory,
        compatibleDevices: compatibleFamilyDevices(device, familyDevices),
      });
    });
    response.json({
      items: serialized,
      nextOffset: devices.length > limit ? offset + limit : null,
      total,
    });
  }),
);

app.get(
  "/api/devices/archived",
  authenticated(async (request, response) => {
    const db = await getDatabase();
    const sort = String(request.query.sort || "model_asc");
    const limit = safeLimit(request.query.limit, 50, 100);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const deviceSort =
      sort === "model_desc"
        ? { brand: -1, model: -1, _id: -1 }
        : { brand: 1, model: 1, _id: 1 };
    const [devices, total] = await Promise.all([
      db
        .collection("devices")
        .find({ status: "archived" })
        .sort(deviceSort)
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
      db.collection("devices").countDocuments({ status: "archived" }),
    ]);
    response.json({
      items: devices.slice(0, limit).map(serialize),
      nextOffset: devices.length > limit ? offset + limit : null,
      total,
    });
  }),
);

app.post(
  "/api/devices/:id/restore",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const db = await getDatabase();
    const deviceId = new ObjectId(request.params.id);
    const device = await db
      .collection("devices")
      .findOne({ _id: deviceId, status: "archived" });
    if (!device)
      return response.status(404).json({ error: "Archived device not found." });
    const { brand, model, brandKey, modelKey } = canonicalDevice(
      device.brand,
      device.model,
    );
    const duplicate = await db.collection("devices").findOne({
      _id: { $ne: deviceId },
      status: { $ne: "archived" },
      $or: [
        { brandKey, modelKey },
        {
          brand: { $regex: `^${escapeRegex(brand)}$`, $options: "i" },
          model: { $regex: `^${escapeRegex(model)}$`, $options: "i" },
        },
      ],
    });
    if (duplicate)
      return response.status(409).json({
        error: `${duplicate.brand} ${duplicate.model} is already active in your catalogue.`,
      });
    const restored = await db.collection("devices").findOneAndUpdate(
      { _id: deviceId, status: "archived" },
      {
        $set: { brand, model, brandKey, modelKey, status: "active", updatedAt: new Date() },
        $unset: { archivedAt: "" },
      },
      { returnDocument: "after" },
    );
    response.status(201).json(serialize(restored));
  }),
);

app.get(
  "/api/devices/:id/archived",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const db = await getDatabase();
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(request.params.id), status: "archived" });
    if (!device)
      return response.status(404).json({ error: "Archived device not found." });
    response.json(serialize(device));
  }),
);

app.get(
  "/api/devices/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const db = await getDatabase();
    const device = await db.collection("devices").findOne({
      _id: new ObjectId(request.params.id),
      status: { $ne: "archived" },
    });
    if (!device)
      return response.status(404).json({ error: "Device not found." });
    const familyDevices = device.coverCompatibilityGroup
      ? await db
          .collection("devices")
          .find({
            status: { $ne: "archived" },
            coverCompatibilityGroup: device.coverCompatibilityGroup,
          })
          .sort({ brand: 1, model: 1 })
          .toArray()
      : [];
    const names = deviceNames(device, familyDevices);
    const covers = await findCompatibleCovers(db, names)
      .sort({ quantityOnHand: -1, _id: 1 })
      .toArray();
    const displayCovers = await attachDisplayDevices(db, covers);
    // This is the user-managed device relationship stored on the device
    // documents. A cover can independently list several models, but that must
    // not appear here as an unlinkable device relationship.
    const compatibleDevices = familyDevices
      .filter((item) => !item._id.equals(device._id))
      .map(serialize)
      .sort((left, right) =>
        `${left.brand} ${left.model}`.localeCompare(
          `${right.brand} ${right.model}`,
        ),
      );
    response.json({
      device: serialize(device),
      covers: displayCovers.map(serialize),
      compatibleDevices,
    });
  }),
);

app.delete(
  "/api/devices/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const db = await getDatabase();
    const deviceId = new ObjectId(request.params.id);
    const device = await db.collection("devices").findOne({
      _id: deviceId,
      status: { $ne: "archived" },
    });
    if (!device) return response.status(404).json({ error: "Device not found." });
    const groupId = device.coverCompatibilityGroup;
    const members = groupId
      ? await db
          .collection("devices")
          .find({ status: { $ne: "archived" }, coverCompatibilityGroup: groupId })
          .toArray()
      : [];
    if (groupId)
      await removeDeletedDeviceFromCompatibilityStock(
        db,
        groupId,
        device,
        members,
        request.user.name,
      );
    const result = await db.collection("devices").updateOne(
      { _id: deviceId, status: { $ne: "archived" } },
      {
        $set: {
          status: "archived",
          archivedAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { coverCompatibilityGroup: "" },
      },
    );
    if (groupId && members.length <= 2)
      await db.collection("devices").updateMany(
        {
          status: { $ne: "archived" },
          coverCompatibilityGroup: groupId,
        },
        { $unset: { coverCompatibilityGroup: "" }, $set: { updatedAt: new Date() } },
      );
    if (!result.matchedCount)
      return response.status(404).json({ error: "Device not found." });
    response.status(204).end();
  }),
);

app.post(
  "/api/devices/:deviceId/compatible-devices/:compatibleDeviceId",
  authenticated(async (request, response) => {
    const { deviceId, compatibleDeviceId } = request.params;
    if (invalidId(deviceId) || invalidId(compatibleDeviceId))
      return response.status(400).json({ error: "Invalid phone id." });
    if (deviceId === compatibleDeviceId)
      return response
        .status(400)
        .json({ error: "Choose a different phone model." });

    const db = await getDatabase();
    const [device, compatibleDevice] = await Promise.all([
      db.collection("devices").findOne({
        _id: new ObjectId(deviceId),
        status: { $ne: "archived" },
      }),
      db.collection("devices").findOne({
        _id: new ObjectId(compatibleDeviceId),
        status: { $ne: "archived" },
      }),
    ]);
    if (!device || !compatibleDevice)
      return response.status(404).json({ error: "Phone not found." });
    const sourceGroup = device.coverCompatibilityGroup;
    const targetGroup = compatibleDevice.coverCompatibilityGroup;
    if (sourceGroup && sourceGroup === targetGroup) {
      const devices = await db
        .collection("devices")
        .find({
          status: { $ne: "archived" },
          coverCompatibilityGroup: sourceGroup,
        })
        .sort({ brand: 1, model: 1 })
        .toArray();
      await consolidateCompatibilityGroupStock(db, sourceGroup, devices);
      return response.json({
        linked: false,
        compatibleDevices: devices
          .filter((item) => !item._id.equals(device._id))
          .map(serialize),
      });
    }

    // A compatibility group is an equivalence class: joining two models also
    // joins every model already verified to share either model's cover.
    const groupId =
      sourceGroup || targetGroup || `manual-${new ObjectId().toHexString()}`;
    const existingGroups = [sourceGroup, targetGroup].filter(Boolean);
    const members = existingGroups.length
      ? {
          $or: [
            {
              _id: {
                $in: [device._id, compatibleDevice._id],
              },
            },
            { coverCompatibilityGroup: { $in: existingGroups } },
          ],
        }
      : { _id: { $in: [device._id, compatibleDevice._id] } };
    await db.collection("devices").updateMany(members, {
      $set: { coverCompatibilityGroup: groupId, updatedAt: new Date() },
    });
    const devices = await db
      .collection("devices")
      .find({
        status: { $ne: "archived" },
        coverCompatibilityGroup: groupId,
      })
      .sort({ brand: 1, model: 1 })
      .toArray();
    await consolidateCompatibilityGroupStock(db, groupId, devices);
    response.status(201).json({
      linked: true,
      compatibleDevices: devices
        .filter((item) => !item._id.equals(device._id))
        .map(serialize),
    });
  }),
);

app.post(
  "/api/devices/:deviceId/compatible-devices/:compatibleDeviceId/unlink",
  authenticated(async (request, response) => {
    const { deviceId, compatibleDeviceId } = request.params;
    if (invalidId(deviceId) || invalidId(compatibleDeviceId))
      return response.status(400).json({ error: "Invalid phone id." });

    const db = await getDatabase();
    const [device, compatibleDevice] = await Promise.all([
      db.collection("devices").findOne({
        _id: new ObjectId(deviceId),
        status: { $ne: "archived" },
      }),
      db.collection("devices").findOne({
        _id: new ObjectId(compatibleDeviceId),
        status: { $ne: "archived" },
      }),
    ]);
    if (!device || !compatibleDevice)
      return response.status(404).json({ error: "Phone not found." });
    if (
      !device.coverCompatibilityGroup ||
      device.coverCompatibilityGroup !==
        compatibleDevice.coverCompatibilityGroup
    )
      return response.json({ linked: false, compatibleDevices: [] });

    const groupId = device.coverCompatibilityGroup;
    const members = await db
      .collection("devices")
      .find({
        status: { $ne: "archived" },
        coverCompatibilityGroup: groupId,
      })
      .toArray();
    const now = new Date();
    await splitCompatibilityGroupStock(
      db,
      groupId,
      device,
      compatibleDevice,
      members,
      request.user.name,
    );
    if (members.length <= 2) {
      // Removing either member from a pair leaves no compatibility family.
      await db
        .collection("devices")
        .updateMany(
          { coverCompatibilityGroup: groupId },
          { $unset: { coverCompatibilityGroup: "" }, $set: { updatedAt: now } },
        );
    } else {
      // Groups are transitive: detach the selected model from the whole family
      // while preserving the relationships among the remaining models.
      await db
        .collection("devices")
        .updateOne(
          { _id: compatibleDevice._id },
          { $unset: { coverCompatibilityGroup: "" }, $set: { updatedAt: now } },
        );
    }
    const remaining =
      members.length <= 2
        ? []
        : await db
            .collection("devices")
            .find({
              status: { $ne: "archived" },
              coverCompatibilityGroup: groupId,
            })
            .sort({ brand: 1, model: 1 })
            .toArray();
    response.json({
      linked: true,
      compatibleDevices: remaining
        .filter((item) => !item._id.equals(device._id))
        .map(serialize),
    });
  }),
);

app.post(
  "/api/devices/:id/transactions",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const body = request.body || {};
    const type = String(body.type || "adjustment");
    const quantity = Number(body.quantity);
    const decreaseTypes = new Set(["sale", "damaged"]);
    const positiveTypes = new Set(["restock", "return", "opening_balance"]);
    const delta = decreaseTypes.has(type)
      ? -Math.abs(quantity)
      : positiveTypes.has(type)
        ? Math.abs(quantity)
        : Number(body.quantityDelta);
    if (!Number.isInteger(delta) || delta === 0)
      return response
        .status(400)
        .json({ error: "Quantity must be a non-zero whole number." });

    const db = await getDatabase();
    const device = await db.collection("devices").findOne({
      _id: new ObjectId(request.params.id),
      status: { $ne: "archived" },
    });
    if (!device)
      return response.status(404).json({ error: "Phone not found." });
    const familyDevices = device.coverCompatibilityGroup
      ? await db
          .collection("devices")
          .find({
            status: { $ne: "archived" },
            coverCompatibilityGroup: device.coverCompatibilityGroup,
          })
          .toArray()
      : [device];
    const compatibleModels = deviceNames(device, familyDevices);
    const matchingCovers = await findCompatibleCovers(db, compatibleModels)
      .sort({ quantityOnHand: -1, updatedAt: -1 })
      .toArray();
    let cover = matchingCovers[0];
    if (!cover && delta > 0) {
      const now = new Date();
      const newCover = {
        quantityOnHand: 0,
        reorderThreshold: 0,
        compatibleModels,
        ...(device.coverCompatibilityGroup
          ? { coverCompatibilityGroup: device.coverCompatibilityGroup }
          : {}),
        status: "active",
        activity: [],
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await db.collection("covers").insertOne(newCover);
      cover = { _id: inserted.insertedId, ...newCover };
    }
    if (!cover)
      return response
        .status(409)
        .json({ error: "There are no covers available for this phone." });
    const result = await mutateCoverStock(db, cover._id, {
      type,
      delta,
      reason: body.reason ? String(body.reason).trim() : null,
      note: body.note ? String(body.note).trim() : null,
      actor: request.user.name,
    });
    if (!result)
      return response
        .status(409)
        .json({ error: "Stock changed. Please refresh and try again." });
    response.status(201).json({
      cover: serialize((await attachDisplayDevices(db, [result.cover]))[0]),
      transaction: serialize({
        _id: result.transaction._id,
        ...result.transaction,
      }),
    });
  }),
);

app.get(
  "/api/search",
  authenticated(async (request, response) => {
    const query = String(request.query.q || "").trim();
    const brand = String(request.query.brand || "").trim();
    const sort = String(request.query.sort || "relevance");
    if (!query) return response.json({ covers: [], devices: [] });
    const limit = safeLimit(request.query.limit, 30);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const pattern = { $regex: escapeRegex(query), $options: "i" };
    // A minimum of three characters keeps the forgiving fallback focused while
    // still allowing "y19se" and common abbreviated/typoed searches such as
    // "viy9" to find "Vivo Y19 SE".
    const fuzzyQueryPattern = fuzzySearchPattern(query);
    const fuzzyPattern = fuzzyQueryPattern
      ? { $regex: fuzzyQueryPattern, $options: "i" }
      : null;
    const brandPattern = brand
      ? { $regex: escapeRegex(brand), $options: "i" }
      : null;
    const deviceSort =
      sort === "name_desc"
        ? { brand: -1, model: -1, _id: -1 }
        : { brand: 1, model: 1, _id: 1 };
    const coverSort =
      sort === "name_asc"
        ? { compatibleModels: 1, _id: 1 }
        : sort === "name_desc"
          ? { compatibleModels: -1, _id: -1 }
          : { quantityOnHand: -1, _id: 1 };
    const db = await getDatabase();
    const deviceMatchClauses: any[] = [
      { brand: pattern },
      { model: pattern },
      { aliases: pattern },
    ];
    if (fuzzyPattern) {
      deviceMatchClauses.push(
        {
          $expr: {
            $regexMatch: {
              input: {
                $concat: [
                  { $ifNull: ["$brand", ""] },
                  " ",
                  { $ifNull: ["$model", ""] },
                ],
              },
              regex: fuzzyPattern.$regex,
              options: "i",
            },
          },
        },
        { aliases: fuzzyPattern },
      );
    }
    const deviceFilter = {
      status: { $ne: "archived" },
      ...(brandPattern
        ? { brand: { $regex: `^${brandPattern.$regex}$`, $options: "i" } }
        : {}),
      $or: deviceMatchClauses,
    };
    const deviceResults =
      sort === "relevance"
        ? db
            .collection("devices")
            .find(deviceFilter)
            .toArray()
            .then((devices) =>
              sortDevicesBySearchMatch(devices, query).slice(
                offset,
                offset + limit + 1,
              ),
            )
        : db
            .collection("devices")
            .find(deviceFilter)
            .sort(deviceSort)
            .skip(offset)
            .limit(limit + 1)
            .toArray();
    const [covers, devices] = await Promise.all([
      db
        .collection("covers")
        .find({
          status: "active",
          $and: [
            fuzzyPattern
              ? {
                  $or: [
                    { compatibleModels: pattern },
                    { compatibleModels: fuzzyPattern },
                  ],
                }
              : { compatibleModels: pattern },
            ...(brandPattern ? [{ compatibleModels: brandPattern }] : []),
          ],
        })
        .sort(coverSort)
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
      deviceResults,
    ]);
    const visibleDevices = devices.slice(0, limit);
    const compatibilityGroups = [
      ...new Set(
        visibleDevices
          .map((device) => device.coverCompatibilityGroup)
          .filter(Boolean),
      ),
    ];
    const familyDevices = compatibilityGroups.length
      ? await db
          .collection("devices")
          .find({
            status: { $ne: "archived" },
            coverCompatibilityGroup: { $in: compatibilityGroups },
          })
          .toArray()
      : [];
    const inventoryNames = [
      ...new Set(
        visibleDevices.flatMap((device) => deviceNames(device, familyDevices)),
      ),
    ];
    const inventoryCovers = inventoryNames.length
      ? await findCompatibleCovers(db, inventoryNames).toArray()
      : [];
    const serializedDevices = visibleDevices.map((device) => {
      const names = new Set(
        deviceNames(device, familyDevices).map(compatibilityKey),
      );
      const matchingCovers = inventoryCovers.filter((cover) =>
        cover.compatibleModels?.some((model) =>
          names.has(compatibilityKey(model)),
        ),
      );
      return serialize({
        ...device,
        inventory: {
          unitsOnHand: matchingCovers.reduce(
            (total, cover) => total + cover.quantityOnHand,
            0,
          ),
          coverVariants: matchingCovers.length,
        },
        compatibleDevices: compatibleFamilyDevices(device, familyDevices),
      });
    });
    response.json({
      covers: (await attachDisplayDevices(db, covers.slice(0, limit), query)).map(
        serialize,
      ),
      devices: serializedDevices,
      hasMore: covers.length > limit || devices.length > limit,
      nextOffset:
        covers.length > limit || devices.length > limit ? offset + limit : null,
    });
  }),
);

app.get(
  "/api/transactions",
  authenticated(async (request, response) => {
    const db = await getDatabase();
    const limit = safeLimit(request.query.limit, 50);
    const before = String(request.query.before || "").trim();
    const sort = String(request.query.sort || "newest");
    const query = String(request.query.q || "")
      .trim()
      .toLocaleLowerCase();
    const direction = sort === "oldest" ? 1 : -1;
    let transactions = await readActivityWithBalances(db);
    transactions.sort((left, right) => {
      const timeDifference =
        new Date(left.createdAt).getTime() -
        new Date(right.createdAt).getTime();
      const idDifference = left._id
        .toString()
        .localeCompare(right._id.toString());
      return direction * (timeDifference || idDifference);
    });
    if (before) {
      const [beforeDate, beforeId] = before.split("|");
      const beforeTime = new Date(beforeDate).getTime();
      transactions = transactions.filter((transaction) => {
        const transactionTime = new Date(transaction.createdAt).getTime();
        const idDifference = transaction._id
          .toString()
          .localeCompare(beforeId || "");
        const difference = transactionTime - beforeTime || idDifference;
        return direction === 1 ? difference > 0 : difference < 0;
      });
    }
    if (query)
      transactions = transactions.filter((transaction) =>
        [...(transaction.compatibleModels || [])].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(query),
        ),
      );
    const page = transactions.slice(0, limit);
    const last = page[page.length - 1];
    response.json({
      items: page.map(serialize),
      nextCursor:
        transactions.length > limit && last
          ? `${last.createdAt.toISOString()}|${last._id.toString()}`
          : null,
    });
  }),
);

app.get(
  "/api/transactions/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid transaction id." });
    const db = await getDatabase();
    const activityId = new ObjectId(request.params.id);
    const legacyTarget = await db
      .collection("transactions")
      .findOne({ _id: activityId }, { projection: { coverId: 1 } });
    const embeddedTarget = legacyTarget
      ? null
      : await db
          .collection("covers")
          .findOne({ "activity._id": activityId }, { projection: { _id: 1 } });
    const coverId = legacyTarget?.coverId || embeddedTarget?._id;
    if (!coverId)
      return response.status(404).json({ error: "Transaction not found." });
    const transaction = (await readActivityWithBalances(db, { coverId })).find(
      (item) => item._id.equals(activityId),
    );
    if (!transaction)
      return response.status(404).json({ error: "Transaction not found." });
    const cover = await db.collection("covers").findOne({ _id: coverId });
    const displayCover = cover
      ? (await attachDisplayDevices(db, [cover]))[0]
      : undefined;
    response.json(
      serialize({
        ...transaction,
        displayDevice: displayCover?.displayDevice,
        compatibleDevices: displayCover?.compatibleDevices || [],
      }),
    );
  }),
);

app.get(
  "/api/dashboard",
  authenticated(async (_, response) => {
    const db = await getDatabase();
    const [summary] = await db
      .collection("covers")
      .aggregate([
        { $match: { status: "active" } },
        {
          $group: {
            _id: null,
            totalUnits: { $sum: "$quantityOnHand" },
            lowStock: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gt: ["$quantityOnHand", 0] },
                      { $lte: ["$quantityOnHand", "$reorderThreshold"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            outOfStock: {
              $sum: { $cond: [{ $eq: ["$quantityOnHand", 0] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();
    const [lowStock, outOfStock] = await Promise.all([
      db
        .collection("covers")
        .find({
          status: "active",
          $expr: {
            $and: [
              { $gt: ["$quantityOnHand", 0] },
              { $lte: ["$quantityOnHand", "$reorderThreshold"] },
            ],
          },
        })
        .sort({ quantityOnHand: 1, updatedAt: -1 })
        .limit(3)
        .toArray(),
      db
        .collection("covers")
        .find({ status: "active", quantityOnHand: 0 })
        .sort({ updatedAt: -1 })
        .limit(3)
        .toArray(),
    ]);
    const allActivity = (await readActivityWithBalances(db)).reverse();
    const shopTimeZone = process.env.SHOP_TIME_ZONE || "Asia/Kolkata";
    const dateFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: shopTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: shopTimeZone,
      weekday: "short",
    });
    const dateKey = (date) => {
      const parts = dateFormatter.formatToParts(date);
      const value = Object.fromEntries(
        parts
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value]),
      );
      return `${value.year}-${value.month}-${value.day}`;
    };
    const salesByDay = new Map();
    allActivity
      .filter((item) => item.type === "sale")
      .forEach((item) => {
        const key = dateKey(new Date(item.createdAt));
        salesByDay.set(
          key,
          (salesByDay.get(key) || 0) + Math.abs(item.quantityDelta),
        );
      });
    const dailySales = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      const key = dateKey(date);
      return {
        date: key,
        label: weekdayFormatter.format(date),
        quantity: salesByDay.get(key) || 0,
      };
    });
    const recentActivity = allActivity.slice(0, 8);
    const dashboardCovers = await attachDisplayDevices(db, [
      ...lowStock,
      ...outOfStock,
    ]);
    const displayCoverById = new Map(
      dashboardCovers.map((cover) => [cover._id.toString(), cover]),
    );
    response.json({
      metrics: {
        totalUnits: summary?.totalUnits || 0,
        lowStock: summary?.lowStock || 0,
        outOfStock: summary?.outOfStock || 0,
      },
      dailySales,
      lowStock: lowStock.map((cover) =>
        serialize(displayCoverById.get(cover._id.toString()) || cover),
      ),
      outOfStock: outOfStock.map((cover) =>
        serialize(displayCoverById.get(cover._id.toString()) || cover),
      ),
      recentActivity: recentActivity.map(serialize),
    });
  }),
);

app.use((error, _, response, __) => {
  if (error?.code === 11000)
    return response.status(409).json({
      error: error.keyPattern?.phone
        ? "An account already uses this phone number."
        : "That record already exists.",
    });
  console.error(error);
  response
    .status(500)
    .json({ error: "Something went wrong. Please try again." });
});

ensureIndexes()
  .then(() =>
    app.listen(port, "0.0.0.0", () =>
      console.log(`CoverStock API listening at http://localhost:${port}`),
    ),
  )
  .catch((error) => {
    console.error(
      "MongoDB connection failed. Start MongoDB locally, then run the API again.",
    );
    console.error(error.message);
    process.exit(1);
  });
