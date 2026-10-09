const brandDisplayNames = new Map(
  [
    "apple",
    "motorola",
    "oppo",
    "realme",
    "redmi",
    "samsung",
    "vivo",
    "xiaomi",
  ].map((name) => [name, `${name[0].toUpperCase()}${name.slice(1)}`]),
);
brandDisplayNames.set("oneplus", "OnePlus");
brandDisplayNames.set("poco", "POCO");
brandDisplayNames.set("mi", "Mi");

// Only whitespace and letter case are ignored. Near-identical models, such as
// A5 and A55, must remain separate catalogue records.
function normalizeDevicePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function canonicalBrand(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  return brandDisplayNames.get(normalizeDevicePart(cleaned)) || cleaned;
}

function canonicalModel(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    // POCO's branding is uppercase, so the merged record has one display name.
    .replace(/\bpoco\b/giu, "POCO");
}

function deviceIdentity(brand, model) {
  return {
    brandKey: normalizeDevicePart(brand),
    modelKey: normalizeDevicePart(model),
  };
}

function canonicalDevice(brand, model) {
  const canonical = {
    brand: canonicalBrand(brand),
    model: canonicalModel(model),
  };
  return { ...canonical, ...deviceIdentity(canonical.brand, canonical.model) };
}

function uniqueNames(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeDevicePart(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  canonicalDevice,
  deviceIdentity,
  normalizeDevicePart,
  uniqueNames,
};
