const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalDevice, deviceIdentity } = require("../src/deviceIdentity");

test("case-only POCO formatting resolves to one canonical device", () => {
  const imported = canonicalDevice("Xiaomi", "Poco C71");
  const curated = canonicalDevice("xiaomi", "POCO C71");

  assert.deepEqual(
    deviceIdentity(imported.brand, imported.model),
    deviceIdentity(curated.brand, curated.model),
  );
  assert.equal(imported.model, "POCO C71");
  assert.equal(curated.model, "POCO C71");
});

test("normalization collapses spacing without merging different models", () => {
  assert.deepEqual(
    deviceIdentity("Samsung", "Galaxy   A55"),
    deviceIdentity(" samsung ", "Galaxy A55 "),
  );
  assert.notDeepEqual(
    deviceIdentity("Samsung", "Galaxy A5"),
    deviceIdentity("Samsung", "Galaxy A55"),
  );
});
