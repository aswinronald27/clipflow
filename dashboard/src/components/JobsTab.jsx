import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Activity, Loader2, FolderOpen, XCircle, CheckCircle2,
  AlertTriangle, Clock, Plus, RefreshCw, Ban,
} from 'lucide-react';
import { apiFetch, apiJson } from '../lib/api';

const STATUS_META = {
  processing: { label: 'PROCESSING', badge: 'badge-brass', icon: Loader2, spin: true },
  queued: { label: 'QUEUED', badge: 'badge-warn', icon: Clock, spin: false },
  completed: { label: 'COMPLETED', badge: 'badge-ok', icon: CheckCircle2, spin: false },
  cancelled: { label: 'CANCELLED', badge: 'badge-warn', icon: Ban, spin: false },
  failed: { label: 'FAILED', badge: 'badge-danger', icon: AlertTriangle, spin: false },
};

function fmtTime(epoch) {
  if (!epoch) return '';
  try {
    return new Date(epoch * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function JobsTab({ currentJobId, onOpenJob, onNewProject }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all'); // all | active | completed | stopped
  const [cancelling, setCancelling] = useState({});
  const [error, setError] = useState('');

  const loadJobs = useCallback(async () => {
    try {
      const res = await apiJson('/api/jobs');
      setData(res);
      setError('');
    } catch {
      setError('Could not load jobs from backend.');
    }
  }, []);

  useEffect(() => {
    loadJobs();
    const id = setInterval(loadJobs, 3000);
    return () => clearInterval(id);
  }, [loadJobs]);

  const jobs = data?.jobs || [];

  const counts = useMemo(() => {
    const c = { all: jobs.length, active: 0, completed: 0, stopped: 0 };
    for (const j of jobs) {
      if (j.status === 'processing' || j.status === 'queued') c.active += 1;
      else if (j.status === 'completed') c.completed += 1;
      else c.stopped += 1;
    }
    return c;
  }, [jobs]);

  const filtered = useMemo(() => {
    if (filter === 'active') return jobs.filter((j) => j.status === 'processing' || j.status === 'queued');
    if (filter === 'completed') return jobs.filter((j) => j.status === 'completed');
    if (filter === 'stopped') return jobs.filter((j) => j.status === 'cancelled' || j.status === 'failed');
    return jobs;
  }, [jobs, filter]);

  const handleCancel = async (jobId) => {
    setCancelling((prev) => ({ ...prev, [jobId]: true }));
    try {
      await apiFetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      await loadJobs();
    } finally {
      setCancelling((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  return (
    <div className="h-full overflow-y-auto custom-scrollbar animate-fade">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <p className="eyebrow mb-1.5">02 · JOBS &amp; QUEUE</p>
            <h1 className="font-display lowercase text-2xl sm:text-3xl text-ink">All jobs</h1>
            <p className="text-muted text-sm mt-1">
              {data
                ? `${data.active_count || 0} active · up to ${data.max_concurrent_jobs || 1} running at once`
                : 'Loading job queue…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadJobs}
              className="btn-ghost px-3 py-2 text-xs"
              title="Refresh jobs"
            >
              <RefreshCw size={14} /> refresh
            </button>
            {onNewProject && (
              <button
                type="button"
                onClick={onNewProject}
                className="btn-primary px-4 py-2 text-xs"
              >
                <Plus size={14} /> new project
              </button>
            )}
          </div>
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {[
            { id: 'all', label: `All (${counts.all})` },
            { id: 'active', label: `Active (${counts.active})` },
            { id: 'completed', label: `Completed (${counts.completed})` },
            { id: 'stopped', label: `Cancelled / Failed (${counts.stopped})` },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-full font-mono text-xs border transition-colors ${filter === f.id
                ? 'border-brass bg-brass/15 text-ink font-medium'
                : 'border-rule2 text-muted hover:border-brass/60 hover:text-ink2'
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <p className="text-danger text-sm mb-4">{error}</p>}

        {data === null && !error ? (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin text-brass" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="card p-12 text-center text-muted">
            <Activity size={32} className="mx-auto mb-3 opacity-60" />
            <p className="text-sm lowercase">No jobs in this view yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((job) => {
              const meta = STATUS_META[job.status] || STATUS_META.failed;
              const Icon = meta.icon;
              const isActive = job.status === 'processing' || job.status === 'queued';
              const isCurrent = job.job_id === currentJobId;
              const dl = job.download_progress;
              const showBar = isActive && dl && dl.status && dl.status !== 'done' && typeof dl.percent === 'number';
              return (
                <div
                  key={job.job_id}
                  className={`card p-4 transition-colors ${isCurrent ? 'border-brass/60' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={meta.badge}>
                          <Icon size={11} className={meta.spin ? 'animate-spin' : ''} />
                          {meta.label}
                        </span>
                        {isCurrent && (
                          <span className="readout text-brass">viewing</span>
                        )}
                        <span className="readout normal-case">{fmtTime(job.created_at)}</span>
                        {job.clips_count > 0 && (
                          <span className="readout bg-paper3 px-2 py-0.5 rounded-full">
                            {job.clips_count} clip{job.clips_count === 1 ? '' : 's'}
                          </span>
                        )}
                        {job.cost_analysis?.total_cost != null && (
                          <span
                            className="readout bg-paper3 px-2 py-0.5 rounded-full"
                            title={`Input: ${job.cost_analysis.input_tokens || 0} | Output: ${job.cost_analysis.output_tokens || 0}`}
                          >
                            GEMINI · ${Number(job.cost_analysis.total_cost).toFixed(5)}
                          </span>
                        )}
                      </div>

                      <p className="text-sm text-ink font-medium truncate" title={job.title}>
                        {job.title || job.job_id}
                      </p>

                      {job.source && job.source !== job.title && (
                        <p className="font-mono text-[11px] text-muted truncate" title={job.source}>
                          {job.source}
                        </p>
                      )}

                      {showBar && (
                        <div className="pt-1 max-w-md space-y-1">
                          <div className="h-1.5 w-full rounded-full bg-paper3 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-brass transition-[width] duration-500"
                              style={{ width: `${Math.max(0, Math.min(100, dl.percent))}%` }}
                            />
                          </div>
                          <p className="font-mono text-[11px] text-brass tabular-nums">
                            {dl.status === 'capturing_live' ? 'Capturing live' : 'Downloading'} · {dl.percent.toFixed(1)}%
                            {dl.chat_messages > 0 ? ` · ${dl.chat_messages} chat msgs` : ''}
                          </p>
                        </div>
                      )}

                      {job.last_log && !showBar && (
                        <p className="font-mono text-[11px] text-muted truncate">
                          {job.last_log}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenJob(job.job_id)}
                        className="btn-ghost px-3 py-1.5 text-xs"
                      >
                        <FolderOpen size={13} />
                        {isActive ? 'watch' : 'open'}
                      </button>
                      {isActive && (
                        <button
                          type="button"
                          onClick={() => handleCancel(job.job_id)}
                          disabled={!!cancelling[job.job_id]}
                          className="btn-danger px-3 py-1.5 text-xs"
                        >
                          {cancelling[job.job_id]
                            ? <Loader2 size={13} className="animate-spin" />
                            : <XCircle size={13} />}
                          cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
