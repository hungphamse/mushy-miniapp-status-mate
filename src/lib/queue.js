// Queue đơn giản: insert vào job_queue, subscribe broadcast `job_completed`.
//
// Pattern:
//   const jobId = await enqueue('process_image', { objectKey });
//   onJob(jobId, (result) => { ... });
//
// Backend: Edge Function poll job_queue → xử lý → broadcast `job_completed`
// với payload { jobId, status, result }.

import { getSupabase } from './supabase.js';
import { getContext } from './context.js';
import { subscribeBroadcast } from './realtime.js';
import config from '../../mushy.config.json';

const slug = config.slug;

export async function enqueue(jobType, payload) {
  const ctx = getContext();
  const { data, error } = await getSupabase()
    .from('job_queue')
    .insert({
      workspace_id: ctx.workspaceId,
      app_slug: slug,
      job_type: jobType,
      payload,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export function onJob(jobId, callback) {
  const ctx = getContext();
  return subscribeBroadcast('job_completed', ctx.workspaceId, (payload) => {
    if (payload.jobId === jobId) callback(payload);
  });
}
