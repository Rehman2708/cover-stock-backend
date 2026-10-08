require("dotenv").config();

const { readFileSync } = require("node:fs");
const { client, ensureIndexes } = require("./src/database");
const { importDeviceCatalog } = require("./src/catalog/importDeviceCatalog");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const includeImages = args.has("--include-images");
const selectedBrandsOnly = args.has("--selected-brands");
const pageArgument = [...args].find((argument) =>
  argument.startsWith("--max-pages="),
);
const maxPages = pageArgument ? Number(pageArgument.split("=")[1]) : undefined;
const allowlistPath = process.env.INDIA_DEVICE_ALLOWLIST_PATH;

function getEligibleProviderIds() {
  if (selectedBrandsOnly) return new Set();
  if (!allowlistPath)
    throw new Error(
      "INDIA_DEVICE_ALLOWLIST_PATH is required. It must point to a verified India-market MobileAPI device-ID JSON list.",
    );
  const list = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (
    !Array.isArray(list) ||
    !list.every((value) => Number.isInteger(value) || typeof value === "string")
  )
    throw new Error(
      "India device allowlist must be a JSON array of MobileAPI device IDs.",
    );
  return new Set(list.map(String));
}

async function run() {
  await ensureIndexes();
  const result = await importDeviceCatalog({
    apiKey: process.env.DEVICE_CATALOG_API_KEY || "",
    includeImages,
    dryRun,
    maxPages,
    eligibleProviderIds: getEligibleProviderIds(),
    selectedBrandsOnly,
  });
  console.log(
    `Imported ${result.imported} devices from ${result.pages} request(s). Provider records seen: ${result.providerTotal}. Back images added: ${result.imagesUpdated}. Complete: ${result.complete}.`,
  );
}

run()
  .then(() => client.close())
  .catch((error) => {
    console.error(error.message);
    client.close().finally(() => process.exit(1));
  });
