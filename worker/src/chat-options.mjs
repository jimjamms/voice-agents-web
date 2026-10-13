// Keep GPT-6 Astra while explicitly reducing reasoning time for voice turns.
export function chatOptions(model) {
  return { model, ...(/^gpt-6(?:[.-]|$)/.test(model) ? { reasoning_effort: 'low' } : {}) };
}
