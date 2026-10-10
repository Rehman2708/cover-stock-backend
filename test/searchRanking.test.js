const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fuzzySearchPattern,
  searchMatchRank,
  sortDevicesBySearchMatch,
} = require("../src/searchRanking");

test("an exact model match outranks a compatible model with a partial match", () => {
  const exactMatch = { brand: "Example", model: "E" };
  const partialMatch = { brand: "Example", model: "Elite" };

  assert.equal(searchMatchRank(exactMatch, "e"), 0);
  assert.equal(searchMatchRank(partialMatch, "e"), 1);
});

test("searching without spaces or punctuation finds the same model", () => {
  const device = { brand: "Vivo", model: "Y19 SE" };

  assert.equal(searchMatchRank(device, "y19se"), 0);
});

test("an abbreviated, ordered-character query still finds the full device name", () => {
  const vivoY19Se = { brand: "Vivo", model: "Y19 SE" };
  const unrelatedDevice = { brand: "Samsung", model: "Galaxy A55" };

  assert.equal(searchMatchRank(vivoY19Se, "viy9"), 4);
  assert.equal(searchMatchRank(unrelatedDevice, "viy9"), 5);
});

test("the database fuzzy patterns match compact and abbreviated searches", () => {
  const deviceName = "Vivo Y19 SE";

  assert.match(deviceName, new RegExp(fuzzySearchPattern("y19se"), "i"));
  assert.match(deviceName, new RegExp(fuzzySearchPattern("viy9"), "i"));
  assert.doesNotMatch(
    "Samsung Galaxy A55",
    new RegExp(fuzzySearchPattern("viy9"), "i"),
  );
});

test("shared-cover members put a specific compact search match first", () => {
  const compatibleDevices = [
    { brand: "Vivo", model: "Y18" },
    { brand: "Vivo", model: "Y19" },
    { brand: "Vivo", model: "Y19 SE" },
    { brand: "Vivo", model: "Y20" },
  ];

  const ranked = sortDevicesBySearchMatch(compatibleDevices, "y19se");

  assert.equal(ranked[0].model, "Y19 SE");
});

test("an abbreviated search still returns the intended device among ambiguous matches", () => {
  const devices = [
    { brand: "Vivo", model: "Y19" },
    { brand: "Vivo", model: "Y19 SE" },
  ];

  const ranked = sortDevicesBySearchMatch(devices, "viy9");

  assert.ok(ranked.some((device) => device.model === "Y19 SE"));
});

test("very short queries do not enable the broad fuzzy fallback", () => {
  assert.equal(fuzzySearchPattern("y1"), null);
});

test("an alias is eligible to identify the matching compatibility member", () => {
  const device = {
    brand: "Example",
    model: "Model E",
    aliases: ["E Edition"],
  };

  assert.equal(searchMatchRank(device, "e edition"), 0);
});
