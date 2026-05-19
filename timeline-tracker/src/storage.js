const KEY = 'timeline_tracker_features';

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
