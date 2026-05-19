export const MILESTONES = [
  { id: 'issue_created',       label: 'Issue Created' },
  { id: 'groomed',             label: 'Groomed' },
  { id: 'picked_up',          label: 'Picked Up' },
  { id: 'in_progress',        label: 'In Progress' },
  { id: 'pr_open',            label: 'PR Open' },
  { id: 'review_received',    label: 'Review Received' },
  { id: 'feedback_addressed', label: 'Feedback Addressed' },
  { id: 'pr_approved',        label: 'PR Approved' },
  { id: 'pr_merged',          label: 'PR Merged' },
];

export const MILESTONE_IDS = MILESTONES.map(m => m.id);

export function milestoneLabel(id) {
  return MILESTONES.find(m => m.id === id)?.label ?? id;
}
