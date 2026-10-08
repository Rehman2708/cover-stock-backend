import "dotenv/config";
const { client, getDatabase } = require("./src/database");

type DeviceSelector = { brand: string; model: string };
type CompatibilityGroup = { id: string; devices: DeviceSelector[] };

// Each group contains models confirmed by the shop to use the same physical cover.
const groups: CompatibilityGroup[] = [
  {
    id: "iphone-3g-3gs",
    devices: [
      { brand: "Apple", model: "iPhone 3G" },
      { brand: "Apple", model: "iPhone 3GS" },
    ],
  },
  {
    id: "iphone-4-family",
    devices: [
      { brand: "Apple", model: "iPhone 4" },
      { brand: "Apple", model: "iPhone 4 CDMA" },
      { brand: "Apple", model: "iPhone 4s" },
    ],
  },
  {
    id: "iphone-5-5s",
    devices: [
      { brand: "Apple", model: "iPhone 5" },
      { brand: "Apple", model: "iPhone 5s" },
    ],
  },
  {
    id: "iphone-6-6s",
    devices: [
      { brand: "Apple", model: "iPhone 6" },
      { brand: "Apple", model: "iPhone 6s" },
    ],
  },
  {
    id: "iphone-12-12-pro",
    devices: [
      { brand: "Apple", model: "iPhone 12" },
      { brand: "Apple", model: "iPhone 12 Pro" },
    ],
  },
  {
    id: "oppo-a12-a12s",
    devices: [
      { brand: "Oppo", model: "A12" },
      { brand: "Oppo", model: "A12s" },
    ],
  },
  {
    id: "realme-14x",
    devices: [
      { brand: "Realme", model: "14x" },
      { brand: "Realme", model: "14x (India)" },
    ],
  },
  {
    id: "realme-c53",
    devices: [
      { brand: "Realme", model: "C53" },
      { brand: "Realme", model: "C53 (India)" },
    ],
  },
  {
    id: "samsung-a72",
    devices: [
      { brand: "Samsung", model: "A72" },
      { brand: "Samsung", model: "A72 5G" },
    ],
  },
  {
    id: "samsung-a73",
    devices: [
      { brand: "Samsung", model: "A73" },
      { brand: "Samsung", model: "A73 5G" },
    ],
  },
  {
    id: "xiaomi-mi-a1-mi-5x",
    devices: [{ brand: "Xiaomi", model: "Mi A1 (Mi 5X)" }],
  },
  {
    id: "xiaomi-mi-a2-mi-6x",
    devices: [{ brand: "Xiaomi", model: "Mi A2 (Mi 6X)" }],
  },
  {
    id: "xiaomi-mi-a2-lite-redmi-6-pro",
    devices: [{ brand: "Xiaomi", model: "Mi A2 Lite (Redmi 6 Pro)" }],
  },
  {
    id: "xiaomi-redmi-4",
    devices: [
      { brand: "Xiaomi", model: "Redmi 4 (4X)" },
      { brand: "Xiaomi", model: "Redmi 4 (China)" },
      { brand: "Xiaomi", model: "Redmi 4 Prime" },
    ],
  },
  {
    id: "xiaomi-redmi-8a",
    devices: [
      { brand: "Xiaomi", model: "Redmi 8A" },
      { brand: "Xiaomi", model: "Redmi 8A Dual" },
      { brand: "Xiaomi", model: "Redmi 8A Pro" },
    ],
  },
  {
    id: "xiaomi-redmi-a3",
    devices: [
      { brand: "Xiaomi", model: "Redmi A3" },
      { brand: "Xiaomi", model: "Redmi A3x" },
      { brand: "Xiaomi", model: "Poco C61" },
    ],
  },
  {
    id: "xiaomi-redmi-13-poco-m6",
    devices: [
      { brand: "Xiaomi", model: "Redmi 13" },
      { brand: "Xiaomi", model: "POCO M6" },
    ],
  },
  {
    id: "xiaomi-redmi-14c",
    devices: [
      { brand: "Xiaomi", model: "Redmi 14C" },
      { brand: "Xiaomi", model: "Redmi 14R" },
      { brand: "Xiaomi", model: "POCO C75" },
      { brand: "Xiaomi", model: "Poco C75" },
    ],
  },
  {
    id: "xiaomi-redmi-15c-poco-c85",
    devices: [
      { brand: "Xiaomi", model: "Redmi 15C 4G" },
      { brand: "Xiaomi", model: "Poco C85 4G" },
    ],
  },
  {
    id: "xiaomi-poco-x3",
    devices: [
      { brand: "Xiaomi", model: "Poco X3" },
      { brand: "Xiaomi", model: "Poco X3 NFC" },
      { brand: "Xiaomi", model: "Poco X3 Pro" },
    ],
  },
  {
    id: "xiaomi-redmi-note-10-pro",
    devices: [
      { brand: "Xiaomi", model: "Redmi Note 10 Pro" },
      { brand: "Xiaomi", model: "Redmi Note 10 Pro Max" },
    ],
  },
  {
    id: "xiaomi-poco-f6-pro-redmi-k70-pro",
    devices: [
      { brand: "Xiaomi", model: "Poco F6 Pro" },
      { brand: "Xiaomi", model: "Redmi K70 Pro" },
    ],
  },
  {
    id: "xiaomi-redmi-note-14-pro-poco-x7",
    devices: [
      { brand: "Xiaomi", model: "Redmi Note 14 Pro" },
      { brand: "Xiaomi", model: "Poco X7" },
    ],
  },
  {
    id: "xiaomi-poco-f7-pro-redmi-k80",
    devices: [
      { brand: "Xiaomi", model: "Poco F7 Pro" },
      { brand: "Xiaomi", model: "Redmi K80" },
    ],
  },
  {
    id: "xiaomi-redmi-9-power-poco-m3",
    devices: [
      { brand: "Xiaomi", model: "Redmi 9 Power" },
      { brand: "Xiaomi", model: "Poco M3" },
    ],
  },
  {
    id: "xiaomi-redmi-9a",
    devices: [
      { brand: "Xiaomi", model: "Redmi 9A" },
      { brand: "Xiaomi", model: "Redmi 9AT" },
      { brand: "Xiaomi", model: "Redmi 9i" },
    ],
  },
  {
    id: "xiaomi-redmi-9-poco-c31",
    devices: [
      { brand: "Xiaomi", model: "Redmi 9" },
      { brand: "Xiaomi", model: "Redmi 9 Activ" },
      { brand: "Xiaomi", model: "Poco C31" },
    ],
  },
  {
    id: "xiaomi-redmi-10",
    devices: [
      { brand: "Xiaomi", model: "Redmi 10" },
      { brand: "Xiaomi", model: "Redmi 10 2022" },
      { brand: "Xiaomi", model: "Redmi 10 Prime" },
      { brand: "Xiaomi", model: "Redmi Note 11 4G" },
    ],
  },
  {
    id: "xiaomi-mi-11-lite",
    devices: [
      { brand: "Xiaomi", model: "Mi 11 Lite" },
      { brand: "Xiaomi", model: "11 Lite 5G NE" },
    ],
  },
  {
    id: "xiaomi-redmi-note-10-note-10s",
    devices: [
      { brand: "Xiaomi", model: "Redmi Note 10" },
      { brand: "Xiaomi", model: "Redmi Note 10S" },
    ],
  },
  {
    id: "xiaomi-redmi-a5-poco-c71",
    devices: [
      { brand: "Xiaomi", model: "Redmi A5" },
      { brand: "Xiaomi", model: "POCO C71" },
      { brand: "Xiaomi", model: "Poco C71" },
    ],
  },
  {
    id: "samsung-a35-m35",
    devices: [
      { brand: "Samsung", model: "A35" },
      { brand: "Samsung", model: "M35" },
    ],
  },
];

async function main() {
  const db = await getDatabase();
  const operations = [];

  for (const group of groups) {
    for (const device of group.devices) {
      const found = await db
        .collection("devices")
        .findOne(device, { projection: { _id: 1 } });
      if (!found)
        throw new Error(
          `Missing device for ${group.id}: ${device.brand} ${device.model}`,
        );
      operations.push({
        updateOne: {
          filter: { _id: found._id },
          update: { $set: { coverCompatibilityGroup: group.id } },
        },
      });
    }
  }

  const result = await db
    .collection("devices")
    .bulkWrite(operations, { ordered: true });
  console.log(
    `Synced ${operations.length} device records across ${groups.length} cover-compatibility groups. Modified: ${result.modifiedCount}.`,
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => client.close());
