// The model choices offered in the editor.
//
// OpenChamber hands an extension no model catalogue, so the list is the models
// the user actually works with: the ones its own picker remembers, plus every
// model an agent file already names.

export type ModelOption = { id: string; hint: string };

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `preferences.json` keeps `{ fields: { key: { value } } }`; tolerate a flat file too. */
const preference = (doc: unknown, key: string): unknown => {
  if (!doc || typeof doc !== 'object') return undefined;
  const fields = (doc as Record<string, unknown>).fields;
  if (fields && typeof fields === 'object' && key in (fields as Record<string, unknown>)) {
    const entry = (fields as Record<string, unknown>)[key];
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>).value : undefined;
  }
  return (doc as Record<string, unknown>)[key];
};

/** `"provider/model"`, or `{ providerID, modelID }`, to one id. */
export const modelId = (value: unknown): string | null => {
  if (typeof value === 'string') return value.includes('/') ? value : null;
  if (!value || typeof value !== 'object') return null;
  const provider = (value as Record<string, unknown>).providerID;
  const model = (value as Record<string, unknown>).modelID;
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  if (provider === '' || model === '') return null;
  return `${provider}/${model}`;
};

/**
 * `preferences` is the parsed preferences file, or `null` when it could not be
 * read. `used` holds the models agent files and the open session name; those are
 * always offered, even when the user hid them in the picker.
 */
export const collectModels = (preferences: unknown, used: string[]): ModelOption[] => {
  const picked = new Map<string, string>();
  const hidden = new Set<string>();
  const add = (id: string | null, hint: string): void => {
    if (id && !picked.has(id)) picked.set(id, hint);
  };

  for (const entry of asArray(preference(preferences, 'hiddenModels'))) {
    const id = modelId(entry);
    if (id) hidden.add(id);
  }
  for (const entry of asArray(preference(preferences, 'favoriteModels'))) add(modelId(entry), 'favorite');
  add(modelId(preference(preferences, 'defaultModel')), 'default');
  for (const entry of asArray(preference(preferences, 'recentModels'))) add(modelId(entry), 'recent');
  const efforts = preference(preferences, 'recentEfforts');
  if (efforts && typeof efforts === 'object') {
    for (const key of Object.keys(efforts as Record<string, unknown>)) add(modelId(key), 'used');
  }
  add(modelId(preference(preferences, 'fallbackModel')), 'fallback');

  const inUse = new Set(used.filter((entry) => entry !== ''));
  const options: ModelOption[] = [];
  for (const [id, hint] of picked) {
    if (!hidden.has(id) || inUse.has(id)) options.push({ id, hint });
  }
  for (const id of [...inUse].sort((left, right) => left.localeCompare(right))) {
    if (!picked.has(id)) options.push({ id, hint: 'in an agent' });
  }
  return options;
};
