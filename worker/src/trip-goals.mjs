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
  result.budget = null;
  if (value.budget != null) {
    const budget = value.budget;
    if (!budget || typeof budget.amount !== 'number' || !Number.isFinite(budget.amount) || budget.amount <= 0 ||
        typeof budget.currency !== 'string' || !budget.currency.trim() || budget.currency.length > 30 ||
        !['per person', 'whole trip'].includes(budget.scope)) throw new Error('Invalid confirmed budget');
    result.budget = { amount: budget.amount, currency: budget.currency.trim(), scope: budget.scope };
  }
  result.itinerary = null;
  if (value.itinerary != null) {
    result.itinerary = {};
    for (const field of ['timing', 'route', 'transport', 'lodging', 'costs']) {
      if (typeof value.itinerary[field] !== 'string' || value.itinerary[field].length > 1000) throw new Error('Invalid itinerary');
      result.itinerary[field] = value.itinerary[field].trim();
    }
  }
  result.finalized = value.finalized === true;
  return result;
}
export function tripReady(choices) {
  return choices.countries.length >= 1 && choices.cities.length >= 3 && choices.activities.length >= 1 && choices.activities.length <= 2 &&
    Boolean(choices.budget) && choices.finalized === true &&
    Boolean(choices.itinerary && ['timing', 'route', 'transport', 'lodging', 'costs'].every(field => choices.itinerary[field]));
}
