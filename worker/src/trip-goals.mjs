export function normalizeChoices(value = { countries: [], cities: [], activities: [] }) {
  if (!value || typeof value !== 'object') throw new Error('Invalid trip choices');
  const result = {};
  for (const field of ['countries', 'cities', 'activities']) {
    if (!Array.isArray(value[field]) || value[field].length > 30) throw new Error('Invalid trip choices');
    const seen = new Set();
    result[field] = value[field].flatMap(item => {
      if (typeof item !== 'string' || !item.trim() || item.length > 100) throw new Error('Invalid trip choice');
      const text = item.trim(), key = text.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key); return [text];
    });
  }
  return result;
}
export function tripReady(choices) {
  return choices.countries.length >= 1 && choices.cities.length >= 3 && choices.activities.length >= 1 && choices.activities.length <= 2;
}
