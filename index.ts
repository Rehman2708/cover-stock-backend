require("dotenv").config();

const express = require("express");
const { ObjectId } = require("mongodb");
const { randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const { ensureIndexes, getDatabase } = require("./src/database");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use((_, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, OPTIONS",
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
  coverName: "$cover.name",
  coverSku: "$cover.sku",
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
          coverName: "$name",
          coverSku: "$sku",
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
const deviceNames = (device, familyDevices) => {
  const related = device.coverCompatibilityGroup
    ? familyDevices.filter(
        (item) =>
          item.coverCompatibilityGroup === device.coverCompatibilityGroup,
      )
    : [device];
  return [
    ...new Set(
      related.flatMap((item) => [
        item.model,
        `${item.brand} ${item.model}`,
        ...(item.aliases || []),
      ]),
    ),
  ];
};

async function attachDisplayDevices(db, covers) {
  if (!covers.length) return covers;
  const devices = await db
    .collection("devices")
    .find({}, { projection: { brand: 1, model: 1, aliases: 1, images: 1 } })
    .toArray();
  const byName = new Map();
  devices.forEach((device) => {
    [
      device.model,
      `${device.brand} ${device.model}`,
      ...(device.aliases || []),
    ].forEach((name) => byName.set(String(name).toLocaleLowerCase(), device));
  });
  return covers.map((cover) => {
    const matchingDevices = [
      ...new Map(
        (cover.compatibleModels || [])
          .map((name) => byName.get(String(name).toLocaleLowerCase()))
          .filter(Boolean)
          .map((device) => [
            device._id.toString(),
            {
              id: device._id.toString(),
              brand: device.brand,
              model: device.model,
              images: device.images,
            },
          ]),
      ).values(),
    ];
    return matchingDevices.length
      ? {
          ...cover,
          displayDevice: matchingDevices[0],
          compatibleDevices: matchingDevices,
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
    { _id: coverId, quantityOnHand: { $gte: Math.max(0, -delta) } },
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
    const limit = safeLimit(request.query.limit, 50, 100);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const stockFilter =
      stock === "in_stock"
        ? { quantityOnHand: { $gt: 0 } }
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
    const [covers, total] = await Promise.all([
      db
        .collection("covers")
        .find(filter)
        .sort({ updatedAt: -1, name: 1, _id: 1 })
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
      .findOne({ _id: new ObjectId(request.params.id) });
    if (!cover) return response.status(404).json({ error: "Cover not found." });
    response.json(serialize((await attachDisplayDevices(db, [cover]))[0]));
  }),
);

app.post(
  "/api/covers",
  authenticated(async (request, response) => {
    const body = request.body || {};
    const name = String(body.name || "").trim();
    const sku = String(body.sku || "").trim();
    const compatibleModels = Array.isArray(body.compatibleModels)
      ? body.compatibleModels.filter(Boolean)
      : [];
    const startingQuantity = Number(body.startingQuantity || 0);
    if (!name || !sku)
      return response.status(400).json({ error: "Name and SKU are required." });
    if (!compatibleModels.length)
      return response
        .status(400)
        .json({ error: "Add at least one compatible phone model." });
    if (!Number.isInteger(startingQuantity) || startingQuantity < 0)
      return response.status(400).json({
        error: "Starting quantity must be a whole number of zero or more.",
      });

    const now = new Date();
    const cover = {
      name,
      sku,
      quantityOnHand: startingQuantity,
      reorderThreshold: Math.max(0, Number(body.reorderThreshold ?? 3)),
      compatibleModels,
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
    const db = await getDatabase();
    const result = await db.collection("covers").insertOne(cover);
    response.status(201).json(serialize({ _id: result.insertedId, ...cover }));
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
    const cover = await db.collection("covers").findOne({ _id: coverId });
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
    const brands = await db
      .collection("devices")
      .aggregate([
        { $match: { brand: { $type: "string", $ne: "" } } },
        { $group: { _id: "$brand", modelCount: { $sum: 1 } } },
        { $project: { _id: 0, brand: "$_id", modelCount: 1 } },
        { $sort: { brand: 1 } },
      ])
      .toArray();
    response.json(brands);
  }),
);

app.post(
  "/api/devices",
  authenticated(async (request, response) => {
    const brand = String(request.body?.brand || "").trim();
    const model = String(request.body?.model || "").trim();
    if (brand.length < 2 || model.length < 1)
      return response.status(400).json({ error: "Enter a brand and model." });
    if (brand.length > 60 || model.length > 100)
      return response
        .status(400)
        .json({ error: "Brand or model is too long." });
    const db = await getDatabase();
    const existing = await db.collection("devices").findOne({
      brand: { $regex: `^${escapeRegex(brand)}$`, $options: "i" },
      model: { $regex: `^${escapeRegex(model)}$`, $options: "i" },
    });
    if (existing)
      return response.status(409).json({
        error: `${existing.brand} ${existing.model} is already in your catalogue.`,
      });
    const now = new Date();
    const device = {
      brand,
      model,
      aliases: [],
      images: {},
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

app.get(
  "/api/devices",
  authenticated(async (request, response) => {
    const db = await getDatabase();
    const brand = String(request.query.brand || "").trim();
    const limit = safeLimit(request.query.limit, 50, 100);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const filter = brand ? { brand } : {};
    const [devices, total] = await Promise.all([
      db
        .collection("devices")
        .find(filter)
        .sort({ brand: 1, model: 1, _id: 1 })
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
          .find({ coverCompatibilityGroup: { $in: compatibilityGroups } })
          .toArray()
      : [];
    const names = [
      ...new Set(items.flatMap((device) => deviceNames(device, familyDevices))),
    ];
    const covers = names.length
      ? await db
          .collection("covers")
          .find({ status: "active", compatibleModels: { $in: names } })
          .toArray()
      : [];
    const serialized = items.map((device) => {
      const compatibleNames = new Set(
        deviceNames(device, familyDevices).map((name) =>
          String(name).toLocaleLowerCase(),
        ),
      );
      const matchingCovers = covers.filter((cover) =>
        cover.compatibleModels?.some((model) =>
          compatibleNames.has(String(model).toLocaleLowerCase()),
        ),
      );
      const inventory = {
        unitsOnHand: matchingCovers.reduce(
          (total, cover) => total + cover.quantityOnHand,
          0,
        ),
        coverVariants: matchingCovers.length,
      };
      return serialize({ ...device, inventory });
    });
    response.json({
      items: serialized,
      nextOffset: devices.length > limit ? offset + limit : null,
      total,
    });
  }),
);

app.get(
  "/api/devices/:id",
  authenticated(async (request, response) => {
    if (invalidId(request.params.id))
      return response.status(400).json({ error: "Invalid device id." });
    const db = await getDatabase();
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(request.params.id) });
    if (!device)
      return response.status(404).json({ error: "Device not found." });
    const familyDevices = device.coverCompatibilityGroup
      ? await db
          .collection("devices")
          .find({ coverCompatibilityGroup: device.coverCompatibilityGroup })
          .sort({ brand: 1, model: 1 })
          .toArray()
      : [];
    const coverDevices = familyDevices.length ? familyDevices : [device];
    const names = [
      ...new Set(
        coverDevices.flatMap((item) => [
          item.model,
          `${item.brand} ${item.model}`,
          ...(item.aliases || []),
        ]),
      ),
    ];
    const covers = await db
      .collection("covers")
      .find({ status: "active", compatibleModels: { $in: names } })
      .sort({ quantityOnHand: -1, name: 1 })
      .toArray();
    const seenModels = new Set();
    const compatibleDevices = familyDevices.filter((item) => {
      const modelKey = `${item.brand} ${item.model}`.toLocaleLowerCase();
      if (
        modelKey === `${device.brand} ${device.model}`.toLocaleLowerCase() ||
        seenModels.has(modelKey)
      )
        return false;
      seenModels.add(modelKey);
      return true;
    });
    response.json({
      device: serialize(device),
      covers: (await attachDisplayDevices(db, covers)).map(serialize),
      compatibleDevices: compatibleDevices.map(serialize),
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
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(request.params.id) });
    if (!device)
      return response.status(404).json({ error: "Phone not found." });
    const familyDevices = device.coverCompatibilityGroup
      ? await db
          .collection("devices")
          .find({ coverCompatibilityGroup: device.coverCompatibilityGroup })
          .toArray()
      : [device];
    const compatibleModels = deviceNames(device, familyDevices);
    const matchingCovers = await db
      .collection("covers")
      .find({ status: "active", compatibleModels: { $in: compatibleModels } })
      .sort({ quantityOnHand: -1, updatedAt: -1 })
      .toArray();
    let cover = matchingCovers[0];
    if (!cover && delta > 0) {
      const now = new Date();
      const newCover = {
        name: `${device.brand} ${device.model} cover`,
        sku: `PHONE-${device._id.toString()}`,
        quantityOnHand: 0,
        reorderThreshold: 0,
        compatibleModels,
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
    if (!query) return response.json({ covers: [], devices: [] });
    const limit = safeLimit(request.query.limit, 30);
    const offset = Math.max(
      Number.parseInt(String(request.query.offset), 10) || 0,
      0,
    );
    const pattern = { $regex: escapeRegex(query), $options: "i" };
    const brandPattern = brand
      ? { $regex: escapeRegex(brand), $options: "i" }
      : null;
    const db = await getDatabase();
    const [covers, devices] = await Promise.all([
      db
        .collection("covers")
        .find({
          status: "active",
          ...(brandPattern ? { compatibleModels: brandPattern } : {}),
          $or: [
            { name: pattern },
            { sku: pattern },
            { compatibleModels: pattern },
          ],
        })
        .sort({ quantityOnHand: -1 })
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
      db
        .collection("devices")
        .find({
          ...(brandPattern
            ? { brand: { $regex: `^${brandPattern.$regex}$`, $options: "i" } }
            : {}),
          $or: [{ brand: pattern }, { model: pattern }, { aliases: pattern }],
        })
        .sort({ brand: 1, model: 1 })
        .skip(offset)
        .limit(limit + 1)
        .toArray(),
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
          .find({ coverCompatibilityGroup: { $in: compatibilityGroups } })
          .toArray()
      : [];
    const inventoryNames = [
      ...new Set(
        visibleDevices.flatMap((device) => deviceNames(device, familyDevices)),
      ),
    ];
    const inventoryCovers = inventoryNames.length
      ? await db
          .collection("covers")
          .find({ status: "active", compatibleModels: { $in: inventoryNames } })
          .toArray()
      : [];
    const serializedDevices = visibleDevices.map((device) => {
      const names = new Set(
        deviceNames(device, familyDevices).map((name) =>
          String(name).toLocaleLowerCase(),
        ),
      );
      const matchingCovers = inventoryCovers.filter((cover) =>
        cover.compatibleModels?.some((model) =>
          names.has(String(model).toLocaleLowerCase()),
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
      });
    });
    response.json({
      covers: (await attachDisplayDevices(db, covers.slice(0, limit))).map(
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
    const query = String(request.query.q || "")
      .trim()
      .toLocaleLowerCase();
    let transactions = (await readActivityWithBalances(db)).reverse();
    if (before) {
      const [beforeDate, beforeId] = before.split("|");
      const beforeTime = new Date(beforeDate).getTime();
      transactions = transactions.filter((transaction) => {
        const transactionTime = new Date(transaction.createdAt).getTime();
        return (
          transactionTime < beforeTime ||
          (transactionTime === beforeTime &&
            transaction._id.toString().localeCompare(beforeId || "") < 0)
        );
      });
    }
    if (query)
      transactions = transactions.filter((transaction) =>
        [
          transaction.coverName,
          transaction.coverSku,
          ...(transaction.compatibleModels || []),
        ].some((value) =>
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
    const displayDevice = cover
      ? (await attachDisplayDevices(db, [cover]))[0].displayDevice
      : undefined;
    response.json(serialize({ ...transaction, displayDevice }));
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
        : "That SKU or device already exists.",
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
