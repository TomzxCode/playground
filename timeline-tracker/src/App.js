import { useState, useEffect, useCallback } from 'react';
import './App.css';
import { MILESTONES, MILESTONE_IDS } from './milestones';
import { loadFeatures, saveFeatures, createFeature, loadSettings, saveSettings, DEFAULT_SETTINGS } from './storage';
import { computePhaseStats, formatHours } from './analytics';
import { parseGitHubUrl, importFromGitHub } from './github';
import { format, parseISO } from 'date-fns';

// ─── Helpers ────────────────────────────────────────────────────────────────

function nextMilestone(feature) {
  return MILESTONE_IDS.find(id => !feature.milestones[id]) ?? null;
}

function doneCount(feature) {
  return MILESTONE_IDS.filter(id => feature.milestones[id]).length;
}

function fmtDatetime(iso) {
  if (!iso) return '';
  return format(parseISO(iso), 'MMM d, yyyy HH:mm');
}

function deltaLabel(prev, curr) {
  if (!prev || !curr) return null;
  const h = (new Date(curr) - new Date(prev)) / 3_600_000;
  return `+${formatHours(h)} since previous`;
}

// ─── Add Feature Modal ───────────────────────────────────────────────────────

function AddFeatureModal({ onAdd, onClose }) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(createFeature({ title: title.trim(), assignee: assignee.trim() }));
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>New Feature</h2>
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Feature / Issue title</label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. User auth flow" />
          </div>
          <div className="form-group">
            <label>Assignee</label>
            <input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="e.g. alice" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Settings Modal ──────────────────────────────────────────────────────────

function SettingsModal({ settings, onSave, onClose }) {
  const [token, setToken] = useState(settings.githubToken);
  const [labelMap, setLabelMap] = useState({ ...settings.labelMap });

  function submit(e) {
    e.preventDefault();
    onSave({ githubToken: token.trim(), labelMap });
    onClose();
  }

  function setLabel(key, val) {
    setLabelMap(m => ({ ...m, [key]: val }));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Settings</h2>
        <form onSubmit={submit}>
          <div className="form-group">
            <label>GitHub Personal Access Token</label>
            <input
              type="password"
              autoFocus
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx"
            />
            <div className="settings-hint">
              Needs <code>repo</code> scope (or <code>public_repo</code> for public repos only).
              Token is stored in your browser's localStorage.
            </div>
          </div>
          <div className="settings-section-title">Label mappings</div>
          <div className="settings-hint" style={{ marginBottom: 12 }}>
            Which GitHub label names correspond to each milestone phase.
          </div>
          {[
            { key: 'groomed', label: 'Groomed' },
            { key: 'in_progress', label: 'In Progress' },
            { key: 'feedback_addressed', label: 'Feedback Addressed' },
          ].map(({ key, label }) => (
            <div className="form-group label-map-row" key={key}>
              <label>{label}</label>
              <input
                value={labelMap[key] ?? ''}
                onChange={e => setLabel(key, e.target.value)}
                placeholder={DEFAULT_SETTINGS.labelMap[key]}
              />
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function ImportModal({ feature, settings, onApply, onClose }) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | preview | error
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function runImport(e) {
    e.preventDefault();
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      setError('Could not parse URL. Expected a GitHub issue or PR link.');
      return;
    }
    if (!settings.githubToken) {
      setError('No GitHub token configured. Open Settings and add your token.');
      return;
    }
    setStatus('loading');
    setError('');
    try {
      const data = await importFromGitHub(settings.githubToken, parsed, settings.labelMap);
      setResult(data);
      setStatus('preview');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  function apply() {
    if (!result) return;
    // Merge: detected milestones overwrite existing; undetected are preserved
    const merged = { ...feature.milestones, ...result.milestones };
    onApply({
      ...feature,
      title: feature.title || result.title,
      assignee: feature.assignee || result.assignee,
      milestones: merged,
      githubUrl: result.sourceUrl,
    });
    onClose();
  }

  const detectedCount = result ? Object.keys(result.milestones).length : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal import-modal" onClick={e => e.stopPropagation()}>
        <h2>Import from GitHub</h2>

        {status !== 'preview' && (
          <form onSubmit={runImport}>
            <div className="form-group">
              <label>Issue or PR URL</label>
              <input
                autoFocus
                value={url}
                onChange={e => { setUrl(e.target.value); setStatus('idle'); setError(''); }}
                placeholder="https://github.com/owner/repo/issues/123"
                disabled={status === 'loading'}
              />
            </div>
            {status === 'loading' && (
              <div className="import-status">
                <span className="spinner" /> Fetching from GitHub…
              </div>
            )}
            {(status === 'idle' || status === 'error') && error && (
              <div className="import-error">{error}</div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={status === 'loading'}>Import</button>
            </div>
          </form>
        )}

        {status === 'preview' && result && (
          <>
            <div className="import-summary">
              <span className="import-count">{detectedCount} / {MILESTONE_IDS.length}</span> milestones detected
              {result.title && <div className="import-meta">Title: <strong>{result.title}</strong></div>}
              {result.assignee && <div className="import-meta">Assignee: <strong>{result.assignee}</strong></div>}
            </div>
            <div className="import-preview">
              {MILESTONES.map(m => {
                const ts = result.milestones[m.id];
                return (
                  <div className="import-preview-item" key={m.id}>
                    <span className="import-preview-label">{m.label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {ts && <span className="import-preview-time">{fmtDatetime(ts)}</span>}
                      <span className={`badge ${ts ? 'badge-detected' : 'badge-skipped'}`}>
                        {ts ? 'detected' : 'not found'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            {error && <div className="import-error" style={{ marginTop: 8 }}>{error}</div>}
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={apply}>Apply to feature</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Milestone Row ───────────────────────────────────────────────────────────

function MilestoneRow({ milestone, prevTimestamp, timestamp, isNext, onLog }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');

  const isDone = !!timestamp;
  const dotClass = isDone ? 'done' : isNext ? 'next' : '';
  const cardClass = isDone ? 'done' : isNext ? 'next' : '';

  function startEdit() {
    const defaultVal = timestamp
      ? format(parseISO(timestamp), "yyyy-MM-dd'T'HH:mm")
      : format(new Date(), "yyyy-MM-dd'T'HH:mm");
    setInputVal(defaultVal);
    setEditing(true);
  }

  function commitEdit() {
    const d = new Date(inputVal);
    if (isNaN(d)) { setEditing(false); return; }
    onLog(milestone.id, d.toISOString());
    setEditing(false);
  }

  return (
    <div className="milestone-row">
      <div className={`milestone-dot ${dotClass}`} />
      <div className={`milestone-card ${cardClass}`}>
        <div className="milestone-top">
          <span className="milestone-label">{milestone.label}</span>
          {isDone
            ? <button className="log-btn" onClick={startEdit}>Edit</button>
            : isNext
              ? <button className="log-btn" onClick={() => onLog(milestone.id, new Date().toISOString())}>Log now</button>
              : null
          }
        </div>
        {isDone && (
          <div className="milestone-time">{fmtDatetime(timestamp)}</div>
        )}
        {isDone && deltaLabel(prevTimestamp, timestamp) && (
          <div className="milestone-delta">{deltaLabel(prevTimestamp, timestamp)}</div>
        )}
        {editing && (
          <div>
            <input
              className="edit-time-input"
              type="datetime-local"
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => e.key === 'Enter' && commitEdit()}
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Feature Detail ──────────────────────────────────────────────────────────

function FeatureDetail({ feature, settings, onChange, onDelete }) {
  const [showImport, setShowImport] = useState(false);
  const next = nextMilestone(feature);

  function logMilestone(id, iso) {
    onChange({ ...feature, milestones: { ...feature.milestones, [id]: iso } });
  }

  return (
    <div>
      <div className="feature-header">
        <div>
          <h2>{feature.title}</h2>
          <div className="feature-header-meta">
            {feature.assignee && <span>Assignee: {feature.assignee} &nbsp;·&nbsp;</span>}
            Created {fmtDatetime(feature.createdAt)}
            {feature.githubUrl && (
              <span> &nbsp;·&nbsp; <a href={feature.githubUrl} target="_blank" rel="noreferrer" className="gh-link">GitHub</a></span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="import-btn" onClick={() => setShowImport(true)}>↓ Import from GitHub</button>
          <button className="delete-btn" onClick={() => { if (window.confirm('Delete this feature?')) onDelete(feature.id); }}>Delete</button>
        </div>
      </div>
      {showImport && (
        <ImportModal
          feature={feature}
          settings={settings}
          onApply={onChange}
          onClose={() => setShowImport(false)}
        />
      )}

      <div className="timeline">
        {MILESTONES.map((m, i) => {
          const prev = i > 0 ? MILESTONES[i - 1].id : null;
          return (
            <MilestoneRow
              key={m.id}
              milestone={m}
              prevTimestamp={prev ? feature.milestones[prev] : null}
              timestamp={feature.milestones[m.id]}
              isNext={next === m.id}
              onLog={logMilestone}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Analytics View ──────────────────────────────────────────────────────────

function AnalyticsView({ features }) {
  const stats = computePhaseStats(features);
  const maxAvg = Math.max(...stats.filter(s => s.avg != null).map(s => s.avg), 1);

  return (
    <div>
      <div className="section-title">Phase Duration Analysis</div>
      {features.length === 0 && (
        <div className="no-data">No features tracked yet. Add some features to see analytics.</div>
      )}
      <div className="analytics-grid">
        {stats.map(s => {
          const isHot = s.avg != null && s.avg === Math.max(...stats.filter(x => x.avg != null).map(x => x.avg));
          return (
            <div className="phase-card" key={s.from}>
              <div className="phase-card-label">{s.label}</div>
              {s.count === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>No data yet</div>
              ) : (
                <>
                  <div className="phase-stats">
                    <div className="stat">
                      <div className={`stat-value ${isHot ? 'highlight' : ''}`}>{formatHours(s.avg)}</div>
                      <div className="stat-label">avg</div>
                    </div>
                    <div className="stat">
                      <div className="stat-value">{formatHours(s.median)}</div>
                      <div className="stat-label">median</div>
                    </div>
                    <div className="stat">
                      <div className="stat-value">{formatHours(s.max)}</div>
                      <div className="stat-label">max</div>
                    </div>
                    <div className="stat">
                      <div className="stat-value">{s.count}</div>
                      <div className="stat-label">samples</div>
                    </div>
                  </div>
                  <div className="bar-track">
                    <div className={`bar-fill ${isHot ? 'hot' : ''}`} style={{ width: `${(s.avg / maxAvg) * 100}%` }} />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {features.length > 0 && (
        <>
          <div className="section-title">All Features</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle}>Feature</th>
                <th style={thStyle}>Assignee</th>
                <th style={thStyle}>Progress</th>
                <th style={thStyle}>Total time</th>
              </tr>
            </thead>
            <tbody>
              {features.map(f => {
                const done = doneCount(f);
                const first = f.milestones[MILESTONE_IDS[0]];
                const last = [...MILESTONE_IDS].reverse().find(id => f.milestones[id]);
                const total = first && last && last !== MILESTONE_IDS[0]
                  ? formatHours((new Date(f.milestones[last]) - new Date(first)) / 3_600_000)
                  : '—';
                return (
                  <tr key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={tdStyle}>{f.title}</td>
                    <td style={tdStyle}>{f.assignee || '—'}</td>
                    <td style={tdStyle}>{done} / {MILESTONE_IDS.length}</td>
                    <td style={tdStyle}>{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' };
const tdStyle = { padding: '10px 12px', fontSize: 13, color: 'var(--text)' };

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({ features, selectedId, onSelect, onAdd, view, onViewChange, onOpenSettings }) {
  const [showModal, setShowModal] = useState(false);

  function handleAdd(feature) {
    onAdd(feature);
    onSelect(feature.id);
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <div>
            <h1>Timeline Tracker</h1>
            <p>Feature bottleneck analyzer</p>
          </div>
          <button className="icon-btn" title="Settings" onClick={onOpenSettings}>⚙</button>
        </div>
      </div>
      <div className="sidebar-tabs">
        <button className={view === 'features' ? 'active' : ''} onClick={() => onViewChange('features')}>Features</button>
        <button className={view === 'analytics' ? 'active' : ''} onClick={() => onViewChange('analytics')}>Analytics</button>
      </div>
      {view === 'features' && (
        <div className="feature-list">
          {features.length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 12, padding: '16px 8px' }}>No features yet.</div>
          )}
          {features.map(f => {
            const done = doneCount(f);
            const next = nextMilestone(f);
            return (
              <div
                key={f.id}
                className={`feature-item ${selectedId === f.id ? 'active' : ''}`}
                onClick={() => { onSelect(f.id); onViewChange('features'); }}
              >
                <div className="feature-item-title">{f.title}</div>
                <div className="feature-item-meta">
                  {f.assignee && <span>{f.assignee}</span>}
                  <span>{done}/{MILESTONE_IDS.length}</span>
                </div>
                <div className="progress-dots">
                  {MILESTONE_IDS.map(id => (
                    <div
                      key={id}
                      className={`dot ${f.milestones[id] ? 'done' : next === id ? 'current' : ''}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button className="add-feature-btn" onClick={() => setShowModal(true)}>+ New Feature</button>
      {showModal && <AddFeatureModal onAdd={handleAdd} onClose={() => setShowModal(false)} />}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [features, setFeatures] = useState(() => loadFeatures());
  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState('features');
  const [settings, setSettings] = useState(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { saveFeatures(features); }, [features]);

  const updateFeature = useCallback(updated => {
    setFeatures(prev => prev.map(f => f.id === updated.id ? updated : f));
  }, []);

  const addFeature = useCallback(feature => {
    setFeatures(prev => [...prev, feature]);
  }, []);

  const deleteFeature = useCallback(id => {
    setFeatures(prev => prev.filter(f => f.id !== id));
    setSelectedId(null);
  }, []);

  function handleSaveSettings(updated) {
    setSettings(updated);
    saveSettings(updated);
  }

  const selected = features.find(f => f.id === selectedId);

  return (
    <div className="app">
      <Sidebar
        features={features}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAdd={addFeature}
        view={view}
        onViewChange={setView}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="main">
        {view === 'analytics' ? (
          <AnalyticsView features={features} />
        ) : selected ? (
          <FeatureDetail
            key={selected.id}
            feature={selected}
            settings={settings}
            onChange={updateFeature}
            onDelete={deleteFeature}
          />
        ) : (
          <div className="empty-state">
            <h3>Select a feature</h3>
            <span>or create a new one to start tracking</span>
          </div>
        )}
      </div>
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
