const { getDatabase } = require("../database");
import {
  aliasesFor,
  MobileApiClient,
  type MobileApiDevice,
  providerBrand,
} from "./mobileApiClient";

export interface CatalogImportOptions {
  apiKey: string;
  includeImages: boolean;
  dryRun: boolean;
  eligibleProviderIds: Set<string>;
  selectedBrandsOnly?: boolean;
  requestBudget?: number;
  maxPages?: number;
}
export interface CatalogImportResult {
  imported: number;
  pages: number;
  providerTotal: number;
  imagesUpdated: number;
  requestsUsed: number;
  complete: boolean;
}

// Current catalogue priority. Expand only when the shop starts carrying covers for another brand.
// MobileAPI groups Mi-branded devices under Xiaomi, so Xiaomi is the provider
// query used for the shop's Mi/Xiaomi priority.
const PROVIDER_BRANDS = [
  "Xiaomi",
  "Realme",
  "Redmi",
  "Apple",
  "Samsung",
  "Oppo",
  "Vivo",
  "OnePlus",
  "Motorola",
];

const BRAND_ALIASES: Array<{ brand: string; aliases: string[] }> = [
  { brand: "Apple", aliases: ["apple"] },
  { brand: "Samsung", aliases: ["samsung"] },
  { brand: "Xiaomi", aliases: ["xiaomi"] },
  { brand: "Mi", aliases: ["mi"] },
  { brand: "Redmi", aliases: ["redmi"] },
  { brand: "Realme", aliases: ["realme"] },
  { brand: "Oppo", aliases: ["oppo"] },
  { brand: "Vivo", aliases: ["vivo"] },
  { brand: "OnePlus", aliases: ["oneplus"] },
  { brand: "Motorola", aliases: ["motorola", "moto"] },
];

function phoneBrand(device: MobileApiDevice) {
  const description = (device.description || "").trim().toLowerCase();
  const name = device.name.toLowerCase();
  // Prefer the provider's explicit classification. Older provider responses may
  // omit it, so the description checks below remain as a conservative fallback.
  if (device.device_type && device.device_type.trim().toLowerCase() !== "phone")
    return null;
  const excludedDevice =
    /\b(feature phone|keypad|qwerty|watch|tablet|ipad|macbook|mac mini|laptop|notebook|desktop|computer|wearable)\b/;
  const runsAndroid = /\bandroid\b/.test(description);
  const isIphone =
    /\bapple iphone\b/.test(description) || /^iphone\b/.test(name);
  // A smartphone label alone is not enough: exclude Windows Mobile and legacy
  // keypad/feature phones. Covers are catalogued only for Android and iOS phones.
  if (
    !description ||
    excludedDevice.test(`${name} ${description}`) ||
    (!runsAndroid && !isIphone)
  )
    return null;
  // The requested manufacturers drive priority and pagination, but a paid API
  // response can still contain another brand. Keep every valid phone returned;
  // only discard non-phones or records whose manufacturer cannot be determined.
  const suppliedBrand = providerBrand(device);
  if (suppliedBrand && suppliedBrand !== "Unknown") return suppliedBrand;
  const match = BRAND_ALIASES.find(({ aliases }) =>
    aliases.some((alias) =>
      new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        description,
      ),
    ),
  );
  if (match) return match.brand;
  const descriptionBrand = description.match(/^([a-z0-9][a-z0-9-]*)\b/i)?.[1];
  return descriptionBrand
    ? `${descriptionBrand[0].toUpperCase()}${descriptionBrand.slice(1)}`
    : null;
}

function imageDataUri(base64?: string) {
  return base64 ? `data:image/jpeg;base64,${base64}` : undefined;
}

function deviceRecord(device: MobileApiDevice, brand: string) {
  return {
    brand,
    model: device.name.trim(),
    aliases: aliasesFor(device),
    source: { provider: "mobileapi", externalId: String(device.id) },
    deviceType: "phone",
    specifications: {
      description: device.description || null,
      display: device.screen_resolution || null,
      rearCamera: device.camera || null,
      hardware: device.hardware || null,
      battery: device.battery_capacity ? String(device.battery_capacity) : null,
      storage: device.storage || null,
      weight: device.weight || null,
      thickness: device.thickness || null,
      colours: device.colors || null,
      releaseDate: device.release_date || null,
    },
    images: {
      primary:
        device.image_url ||
        imageDataUri(device.main_image_b64 || device.image_b64) ||
        null,
      back: null,
    },
    updatedAt: new Date(),
  };
}

async function getBackImage(client: MobileApiClient, deviceId: number) {
  const images = await client.getImages(deviceId);
  const backImage = images.find((image) =>
    /back|rear/i.test(image.caption || ""),
  );
  if (!backImage) return null;
  return backImage.image_url || imageDataUri(backImage.image_b64) || null;
}

async function saveDevices(
  database: any,
  devices: MobileApiDevice[],
  client: MobileApiClient,
  includeImages: boolean,
  dryRun: boolean,
) {
  const operations = [];
  let imagesUpdated = 0;
  for (const device of devices) {
    const brand = phoneBrand(device);
    if (!brand) continue;
    const record = deviceRecord(device, brand);
    if (includeImages) {
      const back = await getBackImage(client, device.id);
      if (back) {
        record.images.back = back;
        imagesUpdated += 1;
      }
    }
    operations.push({
      updateOne: {
        filter: {
          $or: [
            {
              "source.provider": "mobileapi",
              "source.externalId": String(device.id),
            },
            { brand: record.brand, model: record.model },
          ],
        },
        update: { $set: record, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    });
  }
  if (!dryRun && operations.length)
    await database
      .collection("devices")
      .bulkWrite(operations, { ordered: false });
  return { imported: operations.length, imagesUpdated };
}

export async function importDeviceCatalog({
  apiKey,
  includeImages,
  dryRun,
  eligibleProviderIds,
  selectedBrandsOnly = false,
  requestBudget = Number(process.env.DEVICE_CATALOG_REQUEST_BUDGET || 50),
  maxPages,
}: CatalogImportOptions): Promise<CatalogImportResult> {
  if (!apiKey)
    throw new Error(
      "DEVICE_CATALOG_API_KEY is required to import the device catalogue.",
    );
  if (!selectedBrandsOnly && !eligibleProviderIds.size)
    throw new Error(
      "A verified India device allowlist is required. Refusing to import the global catalogue.",
    );
  const client = new MobileApiClient(apiKey);
  const database = dryRun ? null : await getDatabase();
  let imported = 0;
  let imagesUpdated = 0;
  let pageNumber = 1;
  let providerTotal = 0;
  let requestsUsed = 0;

  if (selectedBrandsOnly) {
    const state = dryRun
      ? null
      : await database
          .collection("catalog_sync_state")
          .findOne({ _id: "selected-brands-v1" });
    const savedCursors: Record<string, number | null> = state?.cursors || {};
    // Rebuild from the active priorities so a retired/unsupported alias cannot
    // keep a completed sync permanently incomplete.
    const cursors: Record<string, number | null> = Object.fromEntries(
      PROVIDER_BRANDS.map((brand) => [brand, savedCursors[brand] ?? 1]),
    );
    // Rotate after every request. This keeps a long Xiaomi/Samsung catalogue
    // from starving newer priority brands when the monthly request budget is small.
    let nextBrandIndex = Number.isInteger(state?.nextBrandIndex)
      ? state.nextBrandIndex % PROVIDER_BRANDS.length
      : 1;
    let hasWork = true;
    const effectiveBudget = maxPages
      ? Math.min(requestBudget, maxPages)
      : requestBudget;
    while (requestsUsed < effectiveBudget && hasWork) {
      hasWork = false;
      for (let offset = 0; offset < PROVIDER_BRANDS.length; offset += 1) {
        const brandIndex = (nextBrandIndex + offset) % PROVIDER_BRANDS.length;
        const brand = PROVIDER_BRANDS[brandIndex];
        const currentPage = cursors[brand];
        if (!currentPage || requestsUsed >= effectiveBudget) continue;
        hasWork = true;
        let page;
        try {
          page = await client.listDevicesByManufacturer(brand, currentPage);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("returned 404")
          ) {
            cursors[brand] = null;
            nextBrandIndex = (brandIndex + 1) % PROVIDER_BRANDS.length;
            if (!dryRun)
              await database.collection("catalog_sync_state").updateOne(
                { _id: "selected-brands-v1" },
                {
                  $set: {
                    cursors,
                    nextBrandIndex,
                    updatedAt: new Date(),
                    complete: false,
                  },
                },
                { upsert: true },
              );
            continue;
          }
          throw error;
        }
        requestsUsed += 1;
        providerTotal += page.total;
        const batch = page.devices;
        const saved = await saveDevices(
          database,
          batch,
          client,
          includeImages,
          dryRun,
        );
        imported += saved.imported;
        imagesUpdated += saved.imagesUpdated;
        cursors[brand] = page.has_next ? currentPage + 1 : null;
        nextBrandIndex = (brandIndex + 1) % PROVIDER_BRANDS.length;
        if (!dryRun)
          await database.collection("catalog_sync_state").updateOne(
            { _id: "selected-brands-v1" },
            {
              $set: {
                cursors,
                nextBrandIndex,
                updatedAt: new Date(),
                complete: false,
              },
            },
            { upsert: true },
          );
      }
    }
    const complete = Object.values(cursors).every((cursor) => cursor === null);
    if (!dryRun)
      await database.collection("catalog_sync_state").updateOne(
        { _id: "selected-brands-v1" },
        {
          $set: { cursors, nextBrandIndex, updatedAt: new Date(), complete },
        },
        { upsert: true },
      );
    return {
      imported,
      pages: requestsUsed,
      providerTotal,
      imagesUpdated,
      requestsUsed,
      complete,
    };
  }

  while (true) {
    const page = await client.listDevices(pageNumber);
    requestsUsed += 1;
    providerTotal = page.total;
    const saved = await saveDevices(
      database,
      page.devices.filter((item) => eligibleProviderIds.has(String(item.id))),
      client,
      includeImages,
      dryRun,
    );
    imported += saved.imported;
    imagesUpdated += saved.imagesUpdated;
    if (!page.has_next || (maxPages && pageNumber >= maxPages)) break;
    pageNumber += 1;
  }
  return {
    imported,
    pages: pageNumber,
    providerTotal,
    imagesUpdated,
    requestsUsed,
    complete: true,
  };
}
