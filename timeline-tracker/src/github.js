const API_BASE = 'https://api.github.com';

async function ghFetch(token, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function fetchAllPages(token, path) {
  const items = [];
  let url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.message || msg; } catch {}
      throw new Error(msg);
    }
    items.push(...(await res.json()));
    const link = res.headers.get('Link') ?? '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return items;
}

export function parseGitHubUrl(raw) {
  const m = raw.trim().match(/github\.com\/([^/]+)\/([^/]+)\/(issues?|pull(?:s)?)\/(\d+)/);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    type: m[3].startsWith('pull') ? 'pr' : 'issue',
    number: parseInt(m[4], 10),
  };
}

function mapEvents(issue, timeline, pr, reviews, labelMap) {
  const result = {};

  // issue_created
  result.issue_created = issue.created_at;

  // groomed — first time that label was added
  const groomedName = labelMap.groomed?.toLowerCase();
  if (groomedName) {
    const ev = timeline.find(e =>
      e.event === 'labeled' && e.label?.name?.toLowerCase() === groomedName
    );
    if (ev) result.groomed = ev.created_at;
  }

  // picked_up — first assigned event
  const assignedEv = timeline.find(e => e.event === 'assigned');
  if (assignedEv) result.picked_up = assignedEv.created_at;

  // in_progress — label event
  const inProgressName = labelMap.in_progress?.toLowerCase();
  if (inProgressName) {
    const ev = timeline.find(e =>
      e.event === 'labeled' && e.label?.name?.toLowerCase() === inProgressName
    );
    if (ev) result.in_progress = ev.created_at;
  }

  // pr_open
  if (pr) result.pr_open = pr.created_at;

  // review_received — earliest non-pending review
  const sortedReviews = [...(reviews ?? [])]
    .filter(r => r.state !== 'PENDING' && r.submitted_at)
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  if (sortedReviews.length > 0) {
    result.review_received = sortedReviews[0].submitted_at;
  } else {
    const reviewedEv = timeline.find(e => e.event === 'reviewed');
    if (reviewedEv) result.review_received = reviewedEv.submitted_at;
  }

  // feedback_addressed — explicit label OR first commit/force-push after review
  const feedbackName = labelMap.feedback_addressed?.toLowerCase();
  if (feedbackName) {
    const ev = timeline.find(e =>
      e.event === 'labeled' && e.label?.name?.toLowerCase() === feedbackName
    );
    if (ev) result.feedback_addressed = ev.created_at;
  }
  if (!result.feedback_addressed && result.review_received) {
    const reviewTime = new Date(result.review_received);
    const pushEv = timeline.find(e => {
      if (e.event !== 'head_ref_force_pushed' && e.event !== 'committed') return false;
      const t = new Date(e.created_at ?? e.author?.date);
      return t > reviewTime;
    });
    if (pushEv) result.feedback_addressed = pushEv.created_at ?? pushEv.author?.date;
  }

  // pr_approved — last APPROVED review
  const approved = [...sortedReviews].reverse().find(r => r.state === 'APPROVED');
  if (approved) {
    result.pr_approved = approved.submitted_at;
  } else {
    const approvedEv = [...timeline].reverse().find(e =>
      e.event === 'reviewed' && e.state === 'approved'
    );
    if (approvedEv) result.pr_approved = approvedEv.submitted_at;
  }

  // pr_merged
  if (pr?.merged_at) {
    result.pr_merged = pr.merged_at;
  } else {
    const mergedEv = timeline.find(e => e.event === 'merged');
    if (mergedEv) result.pr_merged = mergedEv.created_at;
  }

  return result;
}

export async function importFromGitHub(token, parsed, labelMap) {
  const { owner, repo, type, number } = parsed;
  let issue, pr, reviews, timeline;

  if (type === 'pr') {
    [pr, timeline, reviews] = await Promise.all([
      ghFetch(token, `/repos/${owner}/${repo}/pulls/${number}`),
      fetchAllPages(token, `/repos/${owner}/${repo}/issues/${number}/timeline`),
      fetchAllPages(token, `/repos/${owner}/${repo}/pulls/${number}/reviews`),
    ]);
    issue = await ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`);
  } else {
    [issue, timeline] = await Promise.all([
      ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`),
      fetchAllPages(token, `/repos/${owner}/${repo}/issues/${number}/timeline`),
    ]);

    // Find linked PRs via cross-referenced events
    const linkedNums = timeline
      .filter(e => e.event === 'cross-referenced' && e.source?.issue?.pull_request)
      .map(e => e.source.issue.number)
      .filter((n, i, arr) => arr.indexOf(n) === i);

    if (linkedNums.length > 0) {
      const prs = await Promise.all(
        linkedNums.map(n =>
          ghFetch(token, `/repos/${owner}/${repo}/pulls/${n}`).catch(() => null)
        )
      );
      // Prefer merged, then open
      pr = prs.filter(Boolean).find(p => p.merged_at) ??
           prs.filter(Boolean).find(p => p.state === 'open') ??
           prs.find(Boolean);
      if (pr) {
        const [prTimeline, prReviews] = await Promise.all([
          fetchAllPages(token, `/repos/${owner}/${repo}/issues/${pr.number}/timeline`),
          fetchAllPages(token, `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`),
        ]);
        timeline = [...timeline, ...prTimeline];
        reviews = prReviews;
      }
    }
  }

  const milestones = mapEvents(issue, timeline, pr ?? null, reviews ?? [], labelMap);

  return {
    title: issue.title,
    assignee: issue.assignee?.login ?? pr?.user?.login ?? '',
    milestones,
    sourceUrl: `https://github.com/${owner}/${repo}/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
  };
}
