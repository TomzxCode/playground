const KEY = 'timeline_tracker_features';
const SETTINGS_KEY = 'timeline_tracker_settings';

export const DEFAULT_SETTINGS = {
  githubToken: '',
  labelMap: {
    groomed: 'groomed',
    in_progress: 'in progress',
    feedback_addressed: 'feedback-addressed',
  },
};

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      labelMap: { ...DEFAULT_SETTINGS.labelMap, ...(stored.labelMap ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadFeatures() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

export function saveFeatures(features) {
  localStorage.setItem(KEY, JSON.stringify(features));
}

export function createFeature({ title, assignee }) {
  return {
    id: crypto.randomUUID(),
    title,
    assignee,
    milestones: {},
    createdAt: new Date().toISOString(),
  };
}
