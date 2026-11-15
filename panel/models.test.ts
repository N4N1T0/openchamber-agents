import { describe, expect, test } from 'bun:test';
import { collectModels, modelId } from './models';

/** The shape OpenChamber's preferences.json uses. */
const PREFERENCES = {
  version: 1,
  fields: {
    defaultModel: { value: 'opencode/nemotron-free' },
    favoriteModels: {
      value: [
        { providerID: 'claude-code', modelID: 'claude-opus-5' },
        { providerID: 'claude-code', modelID: 'claude-haiku-5-5' },
      ],
    },
    recentModels: { value: [{ providerID: 'claude-code', modelID: 'claude-sonnet-5-5' }] },
    recentEfforts: { value: { 'deepseek/deepseek-v4-pro': ['default'], 'claude-code/claude-opus-5': ['default'] } },
    hiddenModels: { value: [{ providerID: 'claude-code', modelID: 'claude-opus-5-5:fast' }] },
  },
};

describe('modelId', () => {
  test('takes both shapes and refuses the rest', () => {
    expect(modelId('a/b')).toBe('a/b');
    expect(modelId({ providerID: 'a', modelID: 'b' })).toBe('a/b');
    expect(modelId('noslash')).toBe(null);
    expect(modelId({ providerID: 'a' })).toBe(null);
    expect(modelId({ providerID: '', modelID: 'b' })).toBe(null);
    expect(modelId(null)).toBe(null);
    expect(modelId(42)).toBe(null);
  });
});

describe('collectModels', () => {
  test('favourites first, then default, recents and remembered efforts', () => {
    expect(collectModels(PREFERENCES, [])).toEqual([
      { id: 'claude-code/claude-opus-5', hint: 'favorite' },
      { id: 'claude-code/claude-haiku-5-5', hint: 'favorite' },
      { id: 'opencode/nemotron-free', hint: 'default' },
      { id: 'claude-code/claude-sonnet-5-5', hint: 'recent' },
      { id: 'deepseek/deepseek-v4-pro', hint: 'used' },
    ]);
  });

  test('a hidden model stays out unless an agent uses it', () => {
    const hidden = 'claude-code/claude-opus-5-5:fast';
    expect(collectModels(PREFERENCES, []).some((option) => option.id === hidden)).toBe(false);
    expect(collectModels(PREFERENCES, [hidden]).some((option) => option.id === hidden)).toBe(true);
  });

  test('a model only an agent names is offered too', () => {
    const options = collectModels(PREFERENCES, ['someone/else']);
    expect(options).toContainEqual({ id: 'someone/else', hint: 'in an agent' });
  });

  test('without preferences the agents own models are the list', () => {
    expect(collectModels(null, ['b/two', 'a/one', ''])).toEqual([
      { id: 'a/one', hint: 'in an agent' },
      { id: 'b/two', hint: 'in an agent' },
    ]);
  });

  test('a flat file without the fields wrapper still reads', () => {
    expect(collectModels({ favoriteModels: [{ providerID: 'p', modelID: 'm' }] }, [])).toEqual([
      { id: 'p/m', hint: 'favorite' },
    ]);
  });

  test('junk never throws and never invents a model', () => {
    expect(collectModels({ fields: 'nope' }, [])).toEqual([]);
    expect(collectModels({}, [])).toEqual([]);
    expect(collectModels('nonsense', [])).toEqual([]);
    expect(collectModels({ recentModels: [null, 3, {}, 'noslash'] }, [])).toEqual([]);
  });
});
