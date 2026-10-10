function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]/g, "");
}

function isSubsequence(query, value) {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function fuzzySearchPattern(query) {
  const compactQuery = compactSearchText(query);
  return compactQuery.length >= 3
    ? [...compactQuery].map(escapeRegex).join(".*")
    : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lower scores are better matches. This lets shared-cover cards identify the
// device the person actually searched for rather than an arbitrary group member.
function searchMatchRank(device, query) {
  const term = compactSearchText(query);
  if (!term) return 5;
  const model = compactSearchText(device.model);
  const fullName = compactSearchText(`${device.brand || ""} ${device.model || ""}`);
  const aliases = (Array.isArray(device.aliases) ? device.aliases : []).map(
    compactSearchText,
  );
  const values = [model, fullName, ...aliases].filter(Boolean);

  if (values.some((value) => value === term)) return 0;
  if (model.startsWith(term)) return 1;
  if (values.some((value) => value.includes(term))) return 2;
  if (model && isSubsequence(term, model)) return 3;
  if (values.some((value) => isSubsequence(term, value))) return 4;
  return 5;
}

function sortDevicesBySearchMatch(devices, query) {
  return [...devices].sort(
    (left, right) =>
      searchMatchRank(left, query) - searchMatchRank(right, query) ||
      `${left.brand || ""} ${left.model || ""}`.localeCompare(
        `${right.brand || ""} ${right.model || ""}`,
      ),
  );
}

module.exports = {
  compactSearchText,
  fuzzySearchPattern,
  searchMatchRank,
  sortDevicesBySearchMatch,
};
