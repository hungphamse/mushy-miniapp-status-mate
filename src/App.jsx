import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DatePicker, { registerLocale } from 'react-datepicker';
import vi from 'date-fns/locale/vi';
import 'react-datepicker/dist/react-datepicker.css';
import { getContext } from './lib/context.js';
import { bridge } from './lib/bridge.js';
import { subscribeToTable } from './lib/realtime.js';
import { subscribeToStatus } from './lib/app/status-realtime.js';
import { useDialog } from './components/Dialog.jsx';
import Select from './components/Select.jsx';
import MemberSearchSelect from './components/MemberSearchSelect.jsx';
import OrgGroupSettingsModal from './components/OrgGroupSettingsModal.jsx';
import { listGroupPeople, personLabel } from './lib/app/people.js';
import { listOrgGroups, createOrgGroup } from './lib/app/org-groups.js';
import {
  fetchOrgChart, listMeetingRooms, listMeetingParticipants, api, slugify, allocationTotals, allocStatus,
  describeEvent, timeAgo, formatVNPhone,
} from './lib/app/api.js';
import './App.css';
import { log } from './lib/app/logger.js';

const GROUP_REMEMBER_KEY = 'orgchart:last_group_id';

registerLocale('vi', vi);

const OTHER = '__other__';

const STATUS_META = {
  available:      { label: 'Available',      tone: 'ok'  },
  busy:           { label: 'Busy',           tone: 'warn' },
  focus:          { label: 'Focus',          tone: 'err' },
  in_meeting:     { label: 'In Meeting',     tone: 'meeting' },
  do_not_disturb: { label: 'Do Not Disturb', tone: 'dnd' },
};

const STATUS_DESCRIPTIONS = {
  available:      'Có thể trao đổi',
  busy:           'Không thể phản hồi ngay',
  focus:          'Chỉ ping nếu urgent',
  in_meeting:     'Đang trong cuộc họp',
  do_not_disturb: 'Không làm phiền — chỉ liên hệ khẩn cấp',
};

const STATUS_FILTERS = [
  { value: 'all',            label: 'Tất cả'         },
  { value: 'available',      label: 'Available'      },
  { value: 'busy',           label: 'Busy'           },
  { value: 'focus',          label: 'Focus'          },
  { value: 'in_meeting',     label: 'In Meeting'     },
  { value: 'do_not_disturb', label: 'Do Not Disturb' },
];

const STATUS_DURATION_OPTIONS = [
  { value: 'none', label: 'Không giới hạn' },
  { value: '25', label: '25 phút' },
  { value: '30', label: '30 phút' },
  { value: '45', label: '45 phút' },
  { value: '60', label: '60 phút' },
  { value: '90', label: '90 phút' },
  { value: '120', label: '2 giờ' },
  { value: '180', label: '3 giờ' },
  { value: '300', label: '5 giờ' },
  { value: '480', label: '8 giờ' },
  { value: '720', label: '12 giờ' },
  { value: '1440', label: '24 giờ' },
  { value: 'custom', label: 'Chọn thời điểm kết thúc' },
];

const MEETING_DURATION_OPTIONS = STATUS_DURATION_OPTIONS.filter((o) => o.value !== 'none');

const MEETING_STATUS_LABELS = {
  scheduled: 'Đã lên lịch',
  active: 'Đang họp',
  ended: 'Đã kết thúc',
  empty: 'Chưa có phòng',
};

// Reason → human-readable label (Team View + PersonActions)
const REASON_LABELS = {
  manual_focus: 'Deep work',
  manual_busy:  'Bận việc',
  meeting_room: 'In Meeting',
  deadline:     'Deadline',
  break:        'Break',
};

// Dropdown options trong editor theo từng status
const REASON_OPTIONS = {
  focus: [
    { value: 'manual_focus', label: 'Deep work' },
    { value: 'deadline',     label: 'Deadline' },
    { value: 'custom',       label: '✎ Tự nhập…' },
  ],
  busy: [
    { value: 'manual_busy',  label: 'Bận việc' },
    { value: 'deadline',     label: 'Deadline' },
    { value: 'break',        label: 'Break' },
    { value: 'custom',       label: '✎ Tự nhập…' },
  ],
  do_not_disturb: [
    { value: 'manual_focus', label: 'Deep work' },
    { value: 'deadline',     label: 'Deadline' },
    { value: 'break',        label: 'Break' },
    { value: 'custom',       label: '✎ Tự nhập…' },
  ],
};

// reason + customReasonText → chuỗi hiển thị. null = không hiện.
function reasonDisplay(reason, customReasonText) {
  if (!reason) return null;
  if (reason === 'custom') return customReasonText?.slice(0, 60) || null;
  return REASON_LABELS[reason] || null;
}

function getStatusMeta(status) {
  return STATUS_META[status] || STATUS_META.available;
}

function normalizeStatus(rawStatus, untilIso, nowMs) {
  const untilMs = untilIso ? new Date(untilIso).getTime() : null;
  const expired = untilMs != null && untilMs <= nowMs;
  const status = !rawStatus || expired ? 'available' : rawStatus;
  return { status, untilMs: expired ? null : untilMs, expired };
}

function formatRemaining(untilMs, nowMs) {
  if (!untilMs || untilMs <= nowMs) return null;
  const totalMin = Math.max(1, Math.ceil((untilMs - nowMs) / 60000));
  if (totalMin < 60) return `Còn ${totalMin} phút`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins ? `Còn ${hours} giờ ${mins} phút` : `Còn ${hours} giờ`;
}

function formatRemainingRounded(untilMs, nowMs) {
  if (!untilMs || untilMs <= nowMs) return null;
  const totalMin = Math.max(1, Math.ceil((untilMs - nowMs) / 60000));
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    return `Còn ${days} ngày`;
  }
  if (totalHours >= 1) return `Còn ${totalHours} giờ`;
  return `Còn ${totalMin} phút`;
}

function statusMessage(status, message) {
  return message || STATUS_DESCRIPTIONS[status] || '';
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function fromLocalInputValue(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toDateFromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isExpiredJwt(token, nowMs = Date.now()) {
  const payload = parseJwtPayload(token);
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 <= nowMs;
}

export default function App() {
  const dialog = useDialog();
  const [ctx, setCtx] = useState(null);
  const [ctxErr, setCtxErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ squads: [], members: [], positions: [], requests: [], events: [] });
  const [people, setPeople] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [myStatus, setMyStatus] = useState('available');
  const [myStatusMsg, setMyStatusMsg] = useState('');
  const [myStatusDuration, setMyStatusDuration] = useState('none');
  const [myStatusUntil, setMyStatusUntil] = useState('');
  const [myStatusBusy, setMyStatusBusy] = useState(false);
  const [myStatusDirty, setMyStatusDirty] = useState(false);
  const [myStatusEditOpen, setMyStatusEditOpen] = useState(false);
  const [myStatusReason, setMyStatusReason] = useState(null);
  const [myStatusCustomText, setMyStatusCustomText] = useState('');
  const [modal, setModal] = useState(null); // { kind, ... }
  // Org groups ws đang subscribe + group đang active.
  const [groups, setGroups] = useState(null);  // null = chưa load
  const [activeGroupId, setActiveGroupId] = useState(() => {
    try { return localStorage.getItem(GROUP_REMEMBER_KEY) || null; } catch { return null; }
  });
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  // Open/close state per squad — default tất cả collapsed. Map id → true (open).
  const [openMap, setOpenMap] = useState({});
  const toggleOpen = useCallback((id) => {
    setOpenMap((m) => ({ ...m, [id]: !m[id] }));
  }, []);
  const expandAll = useCallback(() => {
    setOpenMap(Object.fromEntries(data.squads.map((s) => [s.id, true])));
  }, [data.squads]);
  const collapseAll = useCallback(() => setOpenMap({}), []);

  useEffect(() => {
    try {
        const nextCtx = getContext();
        log.info('ENV: ', import.meta.env.DEV ? 'development' : 'production');
        log.info('Context: ', nextCtx ? 'loaded' : 'null');
        if (nextCtx?.token) {
        	log.info('Validate until: ', parseJwtPayload(nextCtx.token)?.exp ? new Date(parseJwtPayload(nextCtx.token).exp * 1000) : 'invalid token');
        }
      if (import.meta.env.DEV && nextCtx?.token && isExpiredJwt(nextCtx.token)) {
        setCtxErr('VITE_DEV_TOKEN đã hết hạn. Chạy `npm run dev:token` để đăng nhập lại rồi reload trang.');
        return;
      }
      setCtx(nextCtx);
    } catch (e) {
      setCtxErr(e.message);
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const isAdmin = ctx && (ctx.role === 'owner' || ctx.role === 'admin');

  // Load groups khi ctx sẵn sàng. Mặc định pick remembered group hoặc group đầu.
  const reloadGroups = useCallback(async () => {
    if (!ctx?.workspaceId) return;
    try {
      const gs = await listOrgGroups();
      setGroups(gs);
      if (gs.length === 0) {
        setActiveGroupId(null);
      } else if (!activeGroupId || !gs.find((g) => g.id === activeGroupId)) {
        setActiveGroupId(gs[0].id);
      }
    } catch (e) {
      dialog.error('Không tải được org groups', e?.message || String(e));
      setGroups([]);
    }
  }, [ctx, dialog, activeGroupId]);
  useEffect(() => { if (ctx?.workspaceId) reloadGroups(); }, [ctx?.workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist active group.
  useEffect(() => {
    if (activeGroupId) {
      try { localStorage.setItem(GROUP_REMEMBER_KEY, activeGroupId); } catch {}
    }
  }, [activeGroupId]);

  useEffect(() => {
    setStatusFilter('all');
    setMyStatusDirty(false);
    setMyStatusEditOpen(false);
  }, [activeGroupId]);

  const reloadPeople = useCallback(async () => {
    if (!activeGroupId) { setPeople([]); return []; }
    try {
      const ppl = await listGroupPeople(activeGroupId);
      setPeople(ppl);
      return ppl;
    } catch (e) {
      dialog.error('Không tải được danh sách thành viên', e?.message || String(e));
      setPeople([]);
      return [];
    }
  }, [activeGroupId, dialog]);

  const reload = useCallback(async () => {
    if (!activeGroupId) { setData({ squads: [], members: [], positions: [], requests: [], events: [] }); setPeople([]); setLoading(false); return; }
    setLoading(true);
    try {
      const [oc, ppl] = await Promise.all([
        fetchOrgChart(activeGroupId),
        listGroupPeople(activeGroupId),
      ]);
      setData(oc);
      setPeople(ppl);
      return { oc, ppl };
    } catch (e) {
      dialog.error('Không tải được org chart', e?.message || String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [activeGroupId, dialog]);

  useEffect(() => {
    if (activeGroupId) {
      reload();
    } else if (groups !== null) {
      // Groups have loaded but none is active (empty workspace) — nothing to
      // fetch, so clear the loading state that was set on mount.
      setLoading(false);
    }
  }, [activeGroupId, groups, reload]);

  // Realtime subscribe theo workspace_id (PostgREST realtime filter chỉ
  // support eq trên column thật). Ta vẫn subscribe theo ctx.workspaceId
  // — events INSERT cho ws hiện tại sẽ trigger reload. Cross-ws events
  // (squad_events ws khác cùng group) sẽ miss realtime, chờ ↻ tay.
  useEffect(() => {
    if (!ctx?.workspaceId) return;
    let t;
    let unsub = () => {};
    try {
      unsub = subscribeToTable('squad_events', ctx.workspaceId, () => {
        clearTimeout(t);
        t = setTimeout(() => reload(), 400);
      });
    } catch { /* realtime không sẵn sàng — bỏ qua, vẫn dùng ↻ tay */ }
    return () => { clearTimeout(t); try { unsub(); } catch {} };
  }, [ctx, reload]);

  useEffect(() => {
    if (!activeGroupId) return;
    let t;
    let unsub = () => {};
    try {
      unsub = subscribeToStatus(activeGroupId, () => {
        clearTimeout(t);
        t = setTimeout(() => reloadPeople(), 250);
      });
    } catch { /* realtime không sẵn sàng — bỏ qua */ }
    return () => { clearTimeout(t); try { unsub(); } catch {} };
  }, [activeGroupId, reloadPeople]);

  const peopleMap = useMemo(
    () => Object.fromEntries(people.map((p) => [p.user_id, p])),
    [people],
  );
  const totals = useMemo(() => allocationTotals(data.members), [data.members]);
  const statusByUser = useMemo(() => {
    const nowMs = nowTick;
    const map = {};
    for (const p of people) {
      const norm = normalizeStatus(p.status, p.status_until, nowMs);
      map[p.user_id] = {
        status: norm.status,
        message: norm.expired ? null : (p.status_message || null),
        untilMs: norm.untilMs,
        updatedAt: p.status_updated_at || null,
        reason: norm.expired ? null : (p.status_reason || null),
        source: p.status_source || 'self',
        customReasonText: norm.expired ? null : (p.status_custom_reason || null),
        meetingRoomId: norm.expired ? null : (p.meeting_room_id || null),
      };
    }
    return map;
  }, [people, nowTick]);

  useEffect(() => {
    if (!ctx?.userId) return;
    if (myStatusDirty) return;
    const info = statusByUser[ctx.userId];
    const status = info?.status || 'available';
    setMyStatus(status);
    setMyStatusMsg(info?.message || '');
    setMyStatusReason(info?.reason || null);
    setMyStatusCustomText(info?.customReasonText || '');
    if (info?.untilMs) {
      setMyStatusDuration('custom');
      setMyStatusUntil(toLocalInputValue(new Date(info.untilMs).toISOString()));
    } else {
      setMyStatusDuration('none');
      setMyStatusUntil('');
    }
  }, [ctx?.userId, statusByUser, nowTick, myStatusDirty]);

  // Squad đã lưu trữ: CHỈ admin (owner/admin workspace) thấy. Member +
  // squad lead không thấy. Lọc hiển thị (squad_events/data vẫn đủ).
  const visibleSquads = useMemo(
    () => (isAdmin ? data.squads : data.squads.filter((s) => s.status !== 'archived')),
    [data.squads, isAdmin],
  );

  // Cây: gom theo parent_id. Nếu parent bị ẩn (archived + non-admin) thì
  // "nhấc" squad con active lên root để không biến mất khỏi cây.
  const childrenOf = useMemo(() => {
    const visibleIds = new Set(visibleSquads.map((s) => s.id));
    const m = {};
    for (const s of visibleSquads) {
      const k = s.parent_id && visibleIds.has(s.parent_id) ? s.parent_id : '__root__';
      (m[k] = m[k] || []).push(s);
    }
    for (const k in m) m[k].sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [visibleSquads]);

  const membersOf = useMemo(() => {
    const m = {};
    for (const r of data.members) (m[r.squad_id] = m[r.squad_id] || []).push(r);
    return m;
  }, [data.members]);

  // Sub-2: pending requests theo squad + của riêng tôi
  const requestsBySquad = useMemo(() => {
    const m = {};
    for (const r of (data.requests || [])) (m[r.squad_id] = m[r.squad_id] || []).push(r);
    return m;
  }, [data.requests]);
  const myPending = useMemo(() => {
    const m = {};
    for (const r of (data.requests || [])) {
      if (ctx && r.user_id === ctx.userId) m[r.squad_id] = r;
    }
    return m;
  }, [data.requests, ctx]);

  const myTotal = ctx ? (totals[ctx.userId] || 0) : 0;
  const myInAny = ctx && data.members.some((r) => r.user_id === ctx.userId);
  const myStatusInfo = ctx ? (statusByUser[ctx.userId] || { status: 'available', source: 'self' }) : { status: 'available', source: 'self' };
  const myStatusRemain = formatRemainingRounded(myStatusInfo.untilMs, nowTick);
  const myStatusDesc = STATUS_DESCRIPTIONS[myStatusInfo.status] || '';
  const myStatusText = myStatusInfo.message || '';
  const myStatusReasDisplay = reasonDisplay(myStatusInfo.reason, myStatusInfo.customReasonText);

  const saveMyStatus = useCallback(async () => {
    if (!activeGroupId) return;
    let until = null;
    if (myStatusDuration === 'custom') {
      until = fromLocalInputValue(myStatusUntil);
    } else if (myStatusDuration !== 'none') {
      const min = parseInt(myStatusDuration, 10);
      if (Number.isFinite(min) && min > 0) {
        until = new Date(Date.now() + min * 60000).toISOString();
      }
    }
    const reason = myStatus === 'available' ? null : (myStatusReason || null);
    const customText = reason === 'custom' ? (myStatusCustomText.trim() || null) : null;
    setMyStatusBusy(true);
    try {
      await api.setMyStatus(activeGroupId, myStatus, myStatusMsg.trim() || null, until, reason, customText);
      setMyStatusDirty(false);
      setMyStatusEditOpen(false);
      await reloadPeople();
    } catch (e) {
      dialog.error('Không cập nhật được trạng thái', e?.message || String(e));
    } finally {
      setMyStatusBusy(false);
    }
  }, [activeGroupId, myStatus, myStatusMsg, myStatusDuration, myStatusUntil, myStatusReason, myStatusCustomText, dialog, reloadPeople]);

  const clearMyStatus = useCallback(async () => {
    if (!activeGroupId) return;
    setMyStatusBusy(true);
    try {
      await api.clearMyStatus(activeGroupId);
      setMyStatusDirty(false);
      setMyStatus('available');
      setMyStatusMsg('');
      setMyStatusDuration('none');
      setMyStatusUntil('');
      setMyStatusReason(null);
      setMyStatusCustomText('');
      setMyStatusEditOpen(false);
      await reloadPeople();
    } catch (e) {
      dialog.error('Không xoá được trạng thái', e?.message || String(e));
    } finally {
      setMyStatusBusy(false);
    }
  }, [activeGroupId, dialog, reloadPeople]);

  if (ctxErr) {
    return <div className="mushy-page"><div className="mushy-card">
      <h2 className="mushy-section-title">Không có ngữ cảnh</h2>
      <p className="mushy-section-sub">{ctxErr}</p>
    </div></div>;
  }
  if (!ctx) return <div className="oc-center"><span className="mushy-spinner" /></div>;

  const positionOptions = [
    ...data.positions.map((p) => ({ value: p.name, label: p.name })),
    { value: OTHER, label: '✎ Khác (tự nhập)' },
  ];
  const wsMemberOptions = people.map((p) => ({
    value: p.user_id,
    label: personLabel(p) + (p.job_title ? ` · ${p.job_title}` : ''),
  }));

  const roots = childrenOf['__root__'] || [];

  return (
    <div className="mushy-page">
      <header className="oc-hero">
        <img src="/mushy.png" alt="" className="oc-hero-mascot" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="hero-title">Org Chart</h1>
          <p className="hero-sub">
            {visibleSquads.length} squad · {data.members.length} thành viên
            {isAdmin ? ' · bạn là admin' : ''}
          </p>
        </div>
        <button className="mushy-btn mushy-btn--ghost oc-refresh" title="Org Groups"
          onClick={() => setShowGroupSettings(true)}>
          🏢
        </button>
        <button className="mushy-btn mushy-btn--ghost oc-refresh" onClick={reload} disabled={loading}>
          {loading ? <span className="mushy-spinner" /> : '↻'}
        </button>
      </header>

      {groups !== null && groups.length === 0 && (
        <div className="mushy-card" style={{ marginBottom: 14 }}>
          <h2 className="mushy-section-title">Chưa có org group</h2>
          <p className="mushy-section-sub" style={{ marginBottom: 12 }}>
            Workspace chưa thuộc org group nào. Tạo group mới (workspace là origin) hoặc nhập mã share để subscribe group của workspace khác.
          </p>
          <button className="mushy-btn mushy-btn--primary"
            onClick={() => setShowGroupSettings(true)}>
            🏢 Mở Org Groups
          </button>
        </div>
      )}

      {groups !== null && groups.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <label className="mushy-label" style={{ margin: 0, fontSize: 13 }}>Org group:</label>
          <div style={{ flex: 1 }}>
            <Select
              value={activeGroupId || ''}
              onChange={setActiveGroupId}
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
              placeholder="— Chọn —"
            />
          </div>
        </div>
      )}

      {myInAny && allocStatus(myTotal) !== 'ok' && (
        <div className={`oc-banner oc-banner--${allocStatus(myTotal)}`}>
          Tổng phân bổ của bạn đang là <b>{myTotal}%</b>
          {myTotal > 100 ? ' (quá tải — over-allocated)' : ' (chưa đủ 100% — under-allocated)'}.
          Vào squad của bạn để chỉnh lại %allocation cho khớp 100%.
        </div>
      )}

      {activeGroupId && (
        <>
          <MyStatusCard
            currentStatus={myStatusInfo.status}
            currentReason={myStatusReasDisplay}
            currentSource={myStatusInfo.source}
            currentDesc={myStatusDesc}
            currentText={myStatusText}
            remaining={myStatusRemain}
            editStatus={myStatus}
            editMsg={myStatusMsg}
            editDuration={myStatusDuration}
            editUntil={myStatusUntil}
            editReason={myStatusReason}
            editCustomText={myStatusCustomText}
            busy={myStatusBusy}
            editOpen={myStatusEditOpen}
            onEditOpen={() => setMyStatusEditOpen(true)}
            onEditClose={() => setMyStatusEditOpen(false)}
            onStatusSelect={(value) => {
              setMyStatusDirty(true);
              setMyStatus(value);
              const opts = REASON_OPTIONS[value];
              const defaultReason = opts?.[0]?.value ?? null;
              setMyStatusReason(defaultReason);
              if (defaultReason !== 'custom') setMyStatusCustomText('');
            }}
            onMsgChange={(value) => { setMyStatusDirty(true); setMyStatusMsg(value); }}
            onReasonChange={(value) => {
              setMyStatusDirty(true);
              setMyStatusReason(value);
              if (value !== 'custom') setMyStatusCustomText('');
            }}
            onCustomTextChange={(value) => { setMyStatusDirty(true); setMyStatusCustomText(value); }}
            onDurationChange={(value) => {
              setMyStatusDirty(true);
              setMyStatusDuration(value);
              if (value === 'custom') {
                const iso = new Date(Date.now() + 30 * 60000).toISOString();
                setMyStatusUntil(toLocalInputValue(iso));
              } else {
                setMyStatusUntil('');
              }
            }}
            onUntilChange={(value) => { setMyStatusDirty(true); setMyStatusUntil(value); }}
            onSave={saveMyStatus}
            onClear={clearMyStatus}
          />
          <MeetingControlPanel
            activeGroupId={activeGroupId}
            ctx={ctx}
            isAdmin={isAdmin}
            people={people}
            statusByUser={statusByUser}
            nowTick={nowTick}
            dialog={dialog}
            reloadPeople={reloadPeople}
          />
        </>
      )}

      <div className="oc-filter-bar">
        <span className="oc-filter-label">Lọc theo trạng thái</span>
        <div className="oc-filter-chips">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`oc-filter-chip ${statusFilter === f.value ? 'is-active' : ''}`}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="oc-status-callout">
        <div className="oc-status-callout-title">Status-Mate là gì?</div>
        <div className="oc-status-callout-body">
          Tính năng giúp đội nhóm cập nhật trạng thái làm việc theo thời gian thực,
          kết nối đúng lúc và tôn trọng sự tập trung của nhau.
        </div>
      </div>

      {isAdmin && (
        <div className="oc-admin-bar">
          <button className="mushy-btn mushy-btn--primary"
            onClick={() => setModal({ kind: 'create-squad', parent: null })}>
            + Tạo squad
          </button>
          <button className="mushy-btn mushy-btn--ghost"
            onClick={() => setModal({ kind: 'positions' })}>
            ⚙ Vai trò ({data.positions.length})
          </button>
        </div>
      )}

      {loading && data.squads.length === 0 ? (
        <div className="oc-center"><span className="mushy-spinner" /></div>
      ) : roots.length === 0 ? (
        <div className="mushy-card">
          <h2 className="mushy-section-title">Chưa có squad nào</h2>
          <p className="mushy-section-sub">
            {isAdmin ? 'Bấm “+ Tạo squad” để dựng cây tổ chức.'
                     : 'Admin workspace chưa tạo squad. Quay lại sau nhé.'}
          </p>
        </div>
      ) : (
        <>
          <div className="oc-tree-controls">
            <button className="oc-tree-control-btn" onClick={expandAll}>↕ Mở hết</button>
            <button className="oc-tree-control-btn" onClick={collapseAll}>↕ Đóng hết</button>
          </div>
          <div className="oc-tree">
            {roots.map((s) => (
              <SquadNode
                key={s.id} squad={s} depth={0}
                childrenOf={childrenOf} membersOf={membersOf}
                peopleMap={peopleMap} totals={totals}
                requestsBySquad={requestsBySquad} myPending={myPending}
                ctx={ctx} isAdmin={isAdmin} setModal={setModal}
                reload={reload} dialog={dialog}
                openMap={openMap} toggleOpen={toggleOpen}
                statusByUser={statusByUser} statusFilter={statusFilter} nowTick={nowTick}
              />
            ))}
          </div>
        </>
      )}

      {visibleSquads.length > 0 && (
        <ActivityFeed events={data.events} peopleMap={peopleMap} squads={visibleSquads} />
      )}

      <div className="oc-status-legend">
        <div className="oc-section-title">Bảng trạng thái</div>
        <div className="oc-legend-items">
          <div className="oc-legend-item">
            <span className="oc-status-pill oc-status-pill--available"><span className="oc-status-dot" />Available</span>
            <span className="oc-legend-text">Có thể trao đổi (sẵn sàng phản hồi)</span>
          </div>
          <div className="oc-legend-item">
            <span className="oc-status-pill oc-status-pill--busy"><span className="oc-status-dot" />Busy</span>
            <span className="oc-legend-text">Bận việc, có thể phản hồi sau</span>
          </div>
          <div className="oc-legend-item">
            <span className="oc-status-pill oc-status-pill--focus"><span className="oc-status-dot" />Focus</span>
            <span className="oc-legend-text">Đang tập trung, chỉ ping nếu cần thiết</span>
          </div>
          <div className="oc-legend-item">
            <span className="oc-status-pill oc-status-pill--in_meeting"><span className="oc-status-dot" />In Meeting</span>
            <span className="oc-legend-text">Đang trong cuộc họp, host có thể set/restore</span>
          </div>
          <div className="oc-legend-item">
            <span className="oc-status-pill oc-status-pill--do_not_disturb"><span className="oc-status-dot" />Do Not Disturb</span>
            <span className="oc-legend-text">Không làm phiền, chỉ liên hệ khi khẩn cấp</span>
          </div>
        </div>
      </div>

      <div className="oc-status-benefits">
        <div className="oc-section-title">Lợi ích của Status-Mate</div>
        <div className="oc-benefit-grid">
          <div className="oc-benefit-card">
            <div className="oc-benefit-icon">🎯</div>
            <div className="oc-benefit-title">Kết nối đúng lúc</div>
            <div className="oc-benefit-text">Biết ai đang rảnh để trao đổi nhanh chóng, hiệu quả.</div>
          </div>
          <div className="oc-benefit-card">
            <div className="oc-benefit-icon">🧠</div>
            <div className="oc-benefit-title">Tôn trọng sự tập trung</div>
            <div className="oc-benefit-text">Giảm làm phiền, để mọi người duy trì trạng thái deep work.</div>
          </div>
          <div className="oc-benefit-card">
            <div className="oc-benefit-icon">🔎</div>
            <div className="oc-benefit-title">Minh bạch & chủ động</div>
            <div className="oc-benefit-text">Mỗi thành viên chủ động cập nhật, phối hợp mượt mà hơn.</div>
          </div>
        </div>
      </div>

      <footer className="oc-footer">Mushy · org-chart</footer>

      {modal && (
        <ModalHost
          modal={modal} setModal={setModal} close={() => setModal(null)}
          ctx={ctx} activeGroupId={activeGroupId} data={data} people={people}
          positionOptions={positionOptions} wsMemberOptions={wsMemberOptions}
          dialog={dialog} reload={reload}
          statusByUser={statusByUser} nowTick={nowTick}
        />
      )}

      {showGroupSettings && (
        <OrgGroupSettingsModal
          onClose={() => setShowGroupSettings(false)}
          onChange={reloadGroups}
        />
      )}
    </div>
  );
}

function MyStatusCard({
  currentStatus, currentReason, currentSource, currentDesc, currentText, remaining,
  editStatus, editMsg, editDuration, editUntil, editReason, editCustomText,
  onStatusSelect, onMsgChange, onDurationChange, onUntilChange,
  onReasonChange, onCustomTextChange,
  onSave, onClear, busy,
  editOpen, onEditOpen, onEditClose,
}) {
  const meta = getStatusMeta(currentStatus);
  return (
    <div className="oc-status-card">
      <div className="oc-status-card-head">
        <div>
          <div className="oc-status-title">Trạng thái của tôi</div>
          <div className="oc-status-current">
            <span className={`oc-status-pill oc-status-pill--${currentStatus}`}>
              <span className="oc-status-dot" />{meta.label}
            </span>
            {remaining && <span className="oc-status-remaining">{remaining}</span>}
          </div>
          {currentReason && <div className="oc-status-reason-badge">{currentReason}</div>}
          {currentDesc && <div className="oc-status-desc">{currentDesc}</div>}
          {currentText && <div className="oc-status-current-msg">{currentText}</div>}
          {currentSource && currentSource !== 'self' && (
            <div className="oc-status-source-badge">
              {currentSource === 'host' ? '🔒 Host set' : currentSource}
            </div>
          )}
        </div>
        <button className="oc-status-edit-btn" onClick={editOpen ? onEditClose : onEditOpen}>
          {editOpen ? 'Đóng chỉnh sửa' : 'Chỉnh sửa'}
        </button>
      </div>

      {editOpen && (
        <div className="oc-status-editor">
          <div className="oc-status-choices">
            {['available', 'busy', 'focus', 'do_not_disturb'].map((s) => {
              const m = getStatusMeta(s);
              return (
                <button
                  key={s}
                  className={`oc-status-chip oc-status-chip--${s} ${editStatus === s ? 'is-active' : ''}`}
                  onClick={() => onStatusSelect(s)}
                >
                  <span className="oc-status-dot" />{m.label}
                </button>
              );
            })}
          </div>
          <div className="oc-status-desc">
            {STATUS_DESCRIPTIONS[editStatus] || ''}
          </div>

          {editStatus !== 'available' && REASON_OPTIONS[editStatus] && (
            <>
              <label className="oc-label">Lý do</label>
              <Select
                value={editReason || REASON_OPTIONS[editStatus][0].value}
                onChange={onReasonChange}
                options={REASON_OPTIONS[editStatus]}
              />
              {editReason === 'custom' && (
                <input
                  className="mushy-input"
                  value={editCustomText}
                  maxLength={60}
                  onChange={(e) => onCustomTextChange(e.target.value)}
                  placeholder="VD: Client meeting, Code review… (tối đa 60 ký tự)"
                />
              )}
            </>
          )}

          <label className="oc-label">Tin nhắn (tuỳ chọn)</label>
          <textarea
            className="mushy-input oc-textarea"
            value={editMsg}
            maxLength={200}
            onChange={(e) => onMsgChange(e.target.value)}
            placeholder="VD: Đang deep work, ping nếu urgent"
          />

          <label className="oc-label">Thời lượng</label>
          <div className="oc-duration-row">
            <Select
              value={editDuration}
              onChange={onDurationChange}
              options={STATUS_DURATION_OPTIONS}
              placeholder="Chọn thời lượng"
            />
            {editDuration === 'custom' && (
              <DatePicker
                selected={toDateFromLocalInput(editUntil)}
                onChange={(date) => onUntilChange(date ? toLocalInputValue(date.toISOString()) : '')}
                showTimeSelect
                timeIntervals={15}
                dateFormat="Pp"
                timeCaption="Giờ"
                locale="vi"
                placeholderText="Chọn thời điểm kết thúc"
                className="mushy-input oc-datepicker"
              />
            )}
          </div>

          <div className="oc-status-actions">
            <button className="mushy-btn mushy-btn--primary" onClick={onSave} disabled={busy}>
              {busy ? 'Đang lưu…' : 'Cập nhật'}
            </button>
            <button className="mushy-btn mushy-btn--ghost" onClick={onClear} disabled={busy}>
              Xoá trạng thái
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function resolveMeetingUntil(duration, customUntil) {
  if (duration === 'custom') return fromLocalInputValue(customUntil);
  const min = parseInt(duration, 10);
  if (!Number.isFinite(min) || min <= 0) return null;
  return new Date(Date.now() + min * 60000).toISOString();
}

function MeetingControlPanel({
  activeGroupId, ctx, isAdmin, people, statusByUser, nowTick, dialog, reloadPeople,
}) {
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('');
  const [participants, setParticipants] = useState([]);
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState('30');
  const [customUntil, setCustomUntil] = useState('');
  const [participantUserId, setParticipantUserId] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backendReady, setBackendReady] = useState(true);

  const loadRooms = useCallback(async (preferredId = '') => {
    if (!activeGroupId) return;
    try {
      const nextRooms = await listMeetingRooms(activeGroupId);
      setBackendReady(true);
      setRooms(nextRooms);
      setRoomId((prev) => {
        if (preferredId && nextRooms.some((r) => r.id === preferredId)) return preferredId;
        if (prev && nextRooms.some((r) => r.id === prev)) return prev;
        return nextRooms.find((r) => r.status === 'active')?.id || nextRooms[0]?.id || '';
      });
    } catch (e) {
      setBackendReady(false);
      setRooms([]);
      setParticipants([]);
      setRoomId('');
      setDetailOpen(false);
    }
  }, [activeGroupId]);

  const loadParticipants = useCallback(async () => {
    if (!roomId) {
      setParticipants([]);
      return;
    }
    try {
      const nextParticipants = await listMeetingParticipants(roomId);
      setParticipants(nextParticipants);
    } catch {
      setParticipants([]);
    }
  }, [roomId]);

  useEffect(() => { loadRooms(); }, [loadRooms]);
  useEffect(() => { loadParticipants(); }, [loadParticipants]);

  const activeRoom = rooms.find((r) => r.id === roomId) || null;
  const activeParticipants = participants.filter((p) => !p.left_at);
  const participantIds = new Set(activeParticipants.map((p) => p.user_id));
  const meParticipant = activeParticipants.find((p) => p.user_id === ctx?.userId);
  const canManage = !!activeRoom && (
    isAdmin || activeRoom.host_user_id === ctx?.userId || meParticipant?.role === 'co_host'
  );
  const availablePeople = people.filter((p) => !participantIds.has(p.user_id));
  const roomOptions = rooms.map((r) => ({
    value: r.id,
    label: `${r.title || 'Meeting'} · ${MEETING_STATUS_LABELS[r.status] || r.status}`,
  }));
  const activeUntilMs = activeRoom?.planned_end_at
    ? new Date(activeRoom.planned_end_at).getTime()
    : null;
  const roomRemaining = formatRemaining(activeUntilMs, nowTick);
  const roomTitle = activeRoom?.title || 'Meeting';
  const roomStateLabel = MEETING_STATUS_LABELS[activeRoom?.status || 'empty'] || activeRoom?.status || 'empty';

  useEffect(() => {
    if (!activeRoom) setDetailOpen(false);
  }, [activeRoom]);

  const run = async (fn, success) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await fn();
      await loadRooms(result?.id || roomId);
      await loadParticipants();
      await reloadPeople();
      if (success) dialog.success('Đã cập nhật', success);
      return result;
    } catch (e) {
      dialog.error('Chế độ họp lỗi', e?.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createRoom = async () => {
    const until = resolveMeetingUntil(duration, customUntil);
    if (!until) {
      dialog.error('Thiếu thời điểm kết thúc', 'Chọn thời lượng hợp lệ cho phòng họp.');
      return;
    }
    const created = await run(
      () => api.createMeetingRoom(activeGroupId, title.trim() || 'Meeting', until, []),
      'Đã tạo phòng họp.',
    );
    if (created?.id) setRoomId(created.id);
    setDetailOpen(false);
    setTitle('');
  };

  const addParticipant = async () => {
    if (!roomId || !participantUserId) return;
    await run(
      () => api.addMeetingParticipants(roomId, [participantUserId]),
      'Đã thêm người tham gia.',
    );
    setParticipantUserId('');
  };

  const applyAll = async () => {
    if (!roomId || activeRoom?.status !== 'active') return;
    await run(
      () => api.applyMeetingMode(roomId, null, activeRoom.planned_end_at || resolveMeetingUntil(duration, customUntil)),
      'Đã áp dụng In Meeting cho mọi người trong phòng.',
    );
  };

  const setOne = async () => {
    if (!roomId || !targetUserId) return;
    await run(
      () => api.setStatusForMember(
        roomId,
        targetUserId,
        'in_meeting',
        activeRoom?.title || 'In meeting',
        activeRoom?.planned_end_at || resolveMeetingUntil(duration, customUntil),
      ),
      'Đã set In Meeting cho thành viên.',
    );
    setTargetUserId('');
  };

  const restoreOne = async () => {
    if (!roomId || !targetUserId) return;
    await run(
      () => api.restoreMeetingStatusForRoom(roomId, [targetUserId]),
      'Đã khôi phục trạng thái của thành viên.',
    );
    setTargetUserId('');
  };

  const endRoom = async () => {
    if (!roomId) return;
    const ok = await dialog.confirm(
      'Kết thúc phòng họp?',
      'Trạng thái do host set sẽ được khôi phục về trạng thái trước cuộc họp.',
      { confirmLabel: 'Kết thúc', cancelLabel: 'Huỷ' },
    );
    if (!ok) return;
    await run(() => api.endMeetingRoom(roomId, true), 'Đã kết thúc phòng họp.');
  };

  if (detailOpen && activeRoom) {
    return (
      <div className="oc-meeting-panel oc-meeting-panel--detail">
        <div className="oc-meeting-detail-head">
          <button className="oc-back-btn" onClick={() => setDetailOpen(false)}>
            ← Phòng
          </button>
          <div className="oc-meeting-detail-title">
            <div className="oc-status-title">{roomTitle}</div>
            <div className="oc-meeting-sub">
              {activeParticipants.length} người tham gia{roomRemaining ? ` · ${roomRemaining}` : ''}
            </div>
          </div>
          <span className={`oc-meeting-state oc-meeting-state--${activeRoom.status}`}>
            {roomStateLabel}
          </span>
        </div>

        <div className="oc-meeting-actions">
          <button
            className="mushy-btn mushy-btn--ghost"
            disabled={busy || !canManage || activeRoom.status !== 'scheduled'}
            onClick={() => run(() => api.startMeetingRoom(roomId), 'Phòng họp đã bắt đầu.')}
          >
            Bắt đầu
          </button>
          <button
            className="mushy-btn mushy-btn--ghost"
            disabled={busy || !canManage || activeRoom.status !== 'active'}
            onClick={applyAll}
          >
            Áp dụng tất cả
          </button>
          <button
            className="mushy-btn mushy-btn--ghost"
            disabled={busy || !canManage || activeRoom.status === 'ended'}
            onClick={endRoom}
          >
            Kết thúc & khôi phục
          </button>
        </div>

        {canManage && (
          <div className="oc-meeting-tools">
            <div className="oc-meeting-tool">
              <MemberSearchSelect
                value={participantUserId}
                onChange={setParticipantUserId}
                people={availablePeople}
                placeholder="Thêm người tham gia"
              />
              <button className="oc-mini-btn" disabled={busy || !participantUserId} onClick={addParticipant}>
                +
              </button>
            </div>
            <div className="oc-meeting-tool">
              <MemberSearchSelect
                value={targetUserId}
                onChange={setTargetUserId}
                people={people}
                placeholder="Set/khôi phục thành viên"
              />
              <button className="oc-mini-btn" disabled={busy || !targetUserId} onClick={setOne}>
                Set họp
              </button>
              <button className="oc-mini-btn" disabled={busy || !targetUserId} onClick={restoreOne}>
                Khôi phục
              </button>
            </div>
          </div>
        )}

        <div className="oc-meeting-participants">
          {activeParticipants.length === 0 ? (
            <div className="oc-meeting-empty">Chưa có người tham gia.</div>
          ) : activeParticipants.map((p) => {
            const person = people.find((x) => x.user_id === p.user_id);
            const info = statusByUser[p.user_id] || { status: 'available', untilMs: null, source: 'self' };
            const meta = getStatusMeta(info.status);
            const remain = formatRemaining(info.untilMs, nowTick);
            return (
              <div key={p.user_id} className="oc-meeting-participant">
                <div className="oc-meeting-person">
                  <span>{personLabel(person)}</span>
                  <small>{p.role === 'host' ? 'Host' : p.role === 'co_host' ? 'Co-host' : 'Thành viên'}</small>
                </div>
                <span className={`oc-status-pill oc-status-pill--${info.status}`}>
                  <span className="oc-status-dot" />{meta.label}
                </span>
                {info.source === 'host' && <span className="oc-host-badge">Host set</span>}
                {remain && <span className="oc-status-remaining">{remain}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="oc-meeting-panel">
      <div className="oc-meeting-head">
        <div>
          <div className="oc-status-title">Chế độ họp</div>
          <div className="oc-meeting-sub">
            {activeRoom ? `${roomTitle} · ${roomStateLabel}` : 'Tạo hoặc mở nhanh phòng họp'}
          </div>
        </div>
        <span className={`oc-meeting-state oc-meeting-state--${activeRoom?.status || 'empty'}`}>
          {roomStateLabel}
        </span>
      </div>

      {!backendReady ? (
        <div className="oc-meeting-empty">Migration 013 chưa sẵn sàng trên database.</div>
      ) : (
        <>
          <div className="oc-meeting-create">
            <input
              className="mushy-input"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Tên phòng họp"
            />
            <Select
              value={duration}
              onChange={(value) => {
                setDuration(value);
                if (value === 'custom') {
                  setCustomUntil(toLocalInputValue(new Date(Date.now() + 30 * 60000).toISOString()));
                } else {
                  setCustomUntil('');
                }
              }}
              options={MEETING_DURATION_OPTIONS}
              placeholder="Thời lượng"
            />
            {duration === 'custom' && (
              <DatePicker
                selected={toDateFromLocalInput(customUntil)}
                onChange={(date) => setCustomUntil(date ? toLocalInputValue(date.toISOString()) : '')}
                showTimeSelect
                timeIntervals={15}
                dateFormat="Pp"
                timeCaption="Giờ"
                locale="vi"
                placeholderText="Kết thúc lúc"
                className="mushy-input oc-datepicker"
              />
            )}
            <button className="mushy-btn mushy-btn--primary" disabled={busy} onClick={createRoom}>
              Tạo phòng
            </button>
          </div>

          {rooms.length > 0 && (
            <div className="oc-meeting-check">
              <Select value={roomId} onChange={setRoomId} options={roomOptions} placeholder="Chọn phòng họp" />
              {activeRoom && (
                <div className="oc-meeting-summary">
                  <div className="oc-meeting-summary-main">
                    <strong>{roomTitle}</strong>
                    <span>
                      {roomStateLabel}{roomRemaining ? ` · ${roomRemaining}` : ''} · {activeParticipants.length} người
                    </span>
                  </div>
                  <button className="mushy-btn mushy-btn--ghost" onClick={() => setDetailOpen(true)}>
                    Chi tiết
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------- Squad node (đệ quy, collapsible) ----------------
function SquadNode({ squad, depth, childrenOf, membersOf, peopleMap, totals,
  requestsBySquad, myPending, ctx, isAdmin, setModal, reload, dialog,
  openMap, toggleOpen, statusByUser, statusFilter, nowTick }) {
  const open = !!openMap[squad.id];
  const [busy, setBusy] = useState(false);
  const kids = childrenOf[squad.id] || [];
  const memAll = (membersOf[squad.id] || []).slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'lead' ? -1 : 1;
    return 0;
  });
  const mem = statusFilter === 'all'
    ? memAll
    : memAll.filter((r) => (statusByUser[r.user_id]?.status || 'available') === statusFilter);
  const archived = squad.status === 'archived';
  const isLead = squad.lead_user_id === ctx.userId;
  const canManage = isAdmin || isLead;
  const myActive = memAll.some((r) => r.user_id === ctx.userId);
  const myReq = myPending[squad.id];                       // pending của tôi (nếu có)
  const pend = requestsBySquad[squad.id] || [];            // mọi pending của squad

  const statusCounts = memAll.reduce((acc, r) => {
    const st = statusByUser[r.user_id]?.status || 'available';
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, { available: 0, busy: 0, focus: 0, in_meeting: 0, do_not_disturb: 0 });

  // Chạy RPC + reload, báo lỗi qua dialog. Không đóng gì (inline).
  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { dialog.error('Không thực hiện được', e?.message || String(e)); }
    finally { setBusy(false); }
  };

  async function reqLeave() {
    const ok = await dialog.confirm('Đăng ký rời squad?',
      `Gửi yêu cầu rời “${squad.name}”. Squad lead / admin sẽ duyệt.`);
    if (ok) act(() => api.requestMembership(squad.id, 'leave'));
  }
  async function cancelReq() {
    const ok = await dialog.confirm('Huỷ yêu cầu?', 'Yêu cầu đang chờ sẽ bị huỷ.');
    if (ok) act(() => api.cancelMyRequest(myReq.id));
  }

  return (
    <div className="oc-node" style={{ marginLeft: depth ? 14 : 0 }}>
      <div className={`oc-squad ${archived ? 'oc-squad--archived' : ''}`}>
        <div className="oc-squad-head">
          <button className="oc-collapse" onClick={() => toggleOpen(squad.id)}>
            {kids.length || mem.length ? (open ? '▾' : '▸') : '•'}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="oc-squad-title">
              {squad.name}
              {archived && <span className="oc-tag oc-tag--muted">đã lưu trữ</span>}
              {!open && (memAll.length > 0 || kids.length > 0) && (
                <span className="oc-squad-counts">
                  {memAll.length > 0 && <span>{memAll.length} người</span>}
                  {memAll.length > 0 && kids.length > 0 && <span> · </span>}
                  {kids.length > 0 && <span>{kids.length} squad con</span>}
                  {memAll.length > 0 && (
                    <span className="oc-status-counts">
                      <span className="oc-status-count oc-status-count--available">
                        <span className="oc-status-dot" />{statusCounts.available}
                      </span>
                      <span className="oc-status-count oc-status-count--busy">
                        <span className="oc-status-dot" />{statusCounts.busy}
                      </span>
                      <span className="oc-status-count oc-status-count--focus">
                        <span className="oc-status-dot" />{statusCounts.focus}
                      </span>
                      <span className="oc-status-count oc-status-count--in_meeting">
                        <span className="oc-status-dot" />{statusCounts.in_meeting}
                      </span>
                      <span className="oc-status-count oc-status-count--do_not_disturb">
                        <span className="oc-status-dot" />{statusCounts.do_not_disturb}
                      </span>
                    </span>
                  )}
                </span>
              )}
            </div>
            {squad.intro && open && <p className="oc-intro">{squad.intro}</p>}
          </div>
          {(isAdmin || isLead) && (
            <button className="oc-mini-btn"
              onClick={() => setModal({ kind: 'squad-actions', squad, isLead })}>⋯</button>
          )}
        </div>

        {open && (
          <div className="oc-members">
            {mem.length === 0 && (
              <div className="oc-empty-mem">
                {memAll.length === 0 ? 'Chưa có thành viên' : 'Không có thành viên khớp trạng thái'}
              </div>
            )}
            {mem.map((r) => {
              const p = peopleMap[r.user_id];
              const st = allocStatus(totals[r.user_id] || 0);
              const statusInfo = statusByUser[r.user_id] || { status: 'available', message: null, untilMs: null, reason: null, source: 'self', customReasonText: null };
              const statusMeta = getStatusMeta(statusInfo.status);
              const statusDesc = STATUS_DESCRIPTIONS[statusInfo.status] || '';
              const reasonText = reasonDisplay(statusInfo.reason, statusInfo.customReasonText);
              const statusText = statusInfo.message || reasonText || statusDesc;
              const isHostSet = statusInfo.source === 'host';
              const remain = formatRemaining(statusInfo.untilMs, nowTick);
              const mine = r.user_id === ctx.userId;
              return (
                <div key={r.id} className="oc-mem">
                  <div className="oc-avatar">
                    {p?.avatar_url
                      ? <img src={p.avatar_url} alt="" />
                      : <span>{(personLabel(p)[0] || '?').toUpperCase()}</span>}
                  </div>
                  <button className="oc-mem-main"
                    onClick={() => setModal({ kind: 'person', person: p || { user_id: r.user_id } })}>
                    <span className="oc-mem-name">
                      {r.kind === 'lead' && <span className="oc-lead-tag" title="Squad lead">🌟 Lead</span>}
                      {personLabel(p)}
                    </span>
                    <span className="oc-mem-sub">
                      {r.position}{p?.job_title ? ` · ${p.job_title}` : ''}
                    </span>
                    <span className="oc-mem-status">
                      <span className={`oc-status-pill oc-status-pill--${statusInfo.status}`}>
                        <span className="oc-status-dot" />{statusMeta.label}
                      </span>
                      {isHostSet && <span className="oc-host-badge">Host set</span>}
                      <span className="oc-status-msg">
                        {statusText}{remain ? ` · ${remain}` : ''}
                      </span>
                    </span>
                  </button>
                  <span className={`oc-alloc oc-alloc--${st}`} title={`Tổng mọi squad: ${totals[r.user_id] || 0}%`}>
                    {r.allocation}%
                  </span>
                  {p?.companies?.length > 0 && (
                    <span className="oc-company-cluster" title={p.companies.map((c) => c.name).join(', ')}>
                      {p.companies.slice(0, 2).map((c) => (
                        <span key={c.id} className="oc-company-badge" title={c.name}>
                          {c.logo_url
                            ? <img src={c.logo_url} alt={c.name} />
                            : <span className="oc-company-initial">{(c.name?.[0] || '?').toUpperCase()}</span>}
                        </span>
                      ))}
                      {p.companies.length > 2 && (
                        <span className="oc-company-more">+{p.companies.length - 2}</span>
                      )}
                    </span>
                  )}
                  {mine && (
                    <button className="oc-mini-btn"
                      onClick={() => setModal({ kind: 'my-alloc', squad, row: r })}
                      title="Sửa allocation/vai trò của tôi">✎</button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {open && !archived && (
          <div className="oc-self">
            {myReq ? (
              <div className="oc-req-mine">
                <span className="oc-tag oc-tag--muted">
                  ⏳ Đang chờ duyệt: {myReq.type === 'join' ? 'đăng ký vào' : 'đăng ký rời'}
                </span>
                <button className="oc-mini-btn" disabled={busy} onClick={cancelReq}>Huỷ</button>
              </div>
            ) : myActive ? (
              <button className="oc-link-btn" disabled={busy} onClick={reqLeave}>
                Đăng ký rời squad →
              </button>
            ) : (
              <button className="oc-link-btn" disabled={busy}
                onClick={() => setModal({ kind: 'request-join', squad })}>
                + Đăng ký vào squad
              </button>
            )}
          </div>
        )}

        {open && canManage && pend.length > 0 && (
          <div className="oc-pending">
            <div className="oc-pending-title">Yêu cầu chờ duyệt ({pend.length})</div>
            {pend.map((r) => {
              const rp = peopleMap[r.user_id];
              return (
                <div key={r.id} className="oc-req">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="oc-mem-name">
                      {personLabel(rp)}
                      <span className={`oc-tag ${r.type === 'leave' ? 'oc-tag--muted' : ''}`}>
                        {r.type === 'join' ? 'đăng ký vào' : 'đăng ký rời'}
                      </span>
                    </div>
                    <div className="oc-mem-sub">
                      {r.type === 'join'
                        ? `${r.req_position || '—'} · ${r.req_allocation ?? 0}%`
                        : 'Rời squad'}
                      {r.message ? ` · “${r.message}”` : ''}
                    </div>
                  </div>
                  <button className="oc-mini-btn oc-ok" disabled={busy}
                    title="Duyệt"
                    onClick={() => act(() => api.decideMembership(r.id, true))}>✓</button>
                  <button className="oc-mini-btn" disabled={busy}
                    title="Từ chối"
                    onClick={() => act(() => api.decideMembership(r.id, false))}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {open && kids.map((k) => (
        <SquadNode key={k.id} squad={k} depth={depth + 1}
          childrenOf={childrenOf} membersOf={membersOf}
          peopleMap={peopleMap} totals={totals}
          requestsBySquad={requestsBySquad} myPending={myPending}
          ctx={ctx} isAdmin={isAdmin} setModal={setModal}
          reload={reload} dialog={dialog}
          openMap={openMap} toggleOpen={toggleOpen}
          statusByUser={statusByUser} statusFilter={statusFilter} nowTick={nowTick} />
      ))}
    </div>
  );
}

// ---------------- Modal host ----------------
function ModalHost({ modal, setModal, close, ctx, activeGroupId, data, people, positionOptions, wsMemberOptions, dialog, reload, statusByUser, nowTick }) {
  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) await dialog.success('Xong', okMsg);
      close();
      reload();
    } catch (e) {
      dialog.error('Không thực hiện được', e?.message || String(e));
    }
  };

  if (modal.kind === 'squad-actions') {
    const s = modal.squad;
    const admin = ctx.role === 'owner' || ctx.role === 'admin';
    return (
      <Scrim close={close}>
        <h3 className="dialog-title">{s.name}</h3>
        <div className="oc-actions">
          {(admin || modal.isLead) && (
            <button className="mushy-btn mushy-btn--ghost mushy-btn--block"
              onClick={() => setModal({ kind: 'edit-squad', squad: s })}>
              ✎ {admin ? 'Sửa squad' : 'Sửa giới thiệu'}
            </button>
          )}
          {admin && (
            <>
              <button className="mushy-btn mushy-btn--ghost mushy-btn--block"
                onClick={() => setModal({ kind: 'assign-lead', squad: s })}>
                🌟 Gán squad lead
              </button>
              <button className="mushy-btn mushy-btn--ghost mushy-btn--block"
                onClick={() => setModal({ kind: 'add-member', squad: s })}>
                + Thêm thành viên
              </button>
              <button className="mushy-btn mushy-btn--ghost mushy-btn--block"
                onClick={async () => {
                  const archiving = s.status !== 'archived';
                  const ok = await dialog.confirm(
                    archiving ? 'Lưu trữ squad?' : 'Khôi phục squad?',
                    archiving
                      ? 'Squad sẽ ẩn (vẫn giữ data + lịch sử). Có thể khôi phục sau.'
                      : 'Squad sẽ hoạt động lại.',
                  );
                  if (!ok) return;
                  run(() => api.updateSquad(s.id, { status: archiving ? 'archived' : 'active' }),
                    'Đã cập nhật trạng thái squad.');
                }}>
                {s.status === 'archived' ? '♻ Khôi phục' : '🗄 Lưu trữ'}
              </button>
            </>
          )}
        </div>
        <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Đóng</button>
      </Scrim>
    );
  }

  if (modal.kind === 'create-squad' || modal.kind === 'edit-squad') {
    return <SquadForm modal={modal} data={data} run={run} close={close} ctx={ctx} activeGroupId={activeGroupId} />;
  }
  if (modal.kind === 'assign-lead') {
    return <AssignLead squad={modal.squad} people={people}
      positionOptions={positionOptions} run={run} close={close} />;
  }
  if (modal.kind === 'add-member') {
    return <AddMember squad={modal.squad} people={people}
      positionOptions={positionOptions} run={run} close={close} />;
  }
  if (modal.kind === 'my-alloc') {
    return <MyAlloc row={modal.row} squad={modal.squad}
      positionOptions={positionOptions} run={run} close={close} />;
  }
  if (modal.kind === 'positions') {
    return <PositionsManager ctx={ctx} activeGroupId={activeGroupId} data={data} reload={reload} close={close} dialog={dialog} />;
  }
  if (modal.kind === 'request-join') {
    return <RequestJoin squad={modal.squad} positionOptions={positionOptions}
      run={run} close={close} />;
  }
  if (modal.kind === 'person') {
    return <PersonActions person={modal.person} close={close} dialog={dialog} statusByUser={statusByUser} nowTick={nowTick} />;
  }
  return null;
}

function Scrim({ children, close }) {
  return (
    <div className="modal-scrim" onClick={close}>
      <div className="modal-card oc-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function SquadForm({ modal, data, run, close, ctx, activeGroupId }) {
  const editing = modal.kind === 'edit-squad';
  const s = modal.squad;
  const [name, setName] = useState(editing ? s.name : '');
  const [slug, setSlug] = useState(editing ? s.slug : '');
  const [slugTouched, setSlugTouched] = useState(editing);
  const [intro, setIntro] = useState(editing ? (s.intro || '') : '');
  const [parent, setParent] = useState(editing ? (s.parent_id || '') : (modal.parent || ''));
  const admin = ctx.role === 'owner' || ctx.role === 'admin';
  const leadOnly = editing && !admin; // lead chỉ sửa intro

  const parentOpts = [
    { value: '', label: '— Không có (squad gốc) —' },
    ...data.squads
      .filter((x) => x.id !== (editing ? s.id : null))
      .map((x) => ({ value: x.id, label: x.name })),
  ];

  return (
    <Scrim close={close}>
      <h3 className="dialog-title">{editing ? 'Sửa squad' : 'Tạo squad'}</h3>

      {!leadOnly && (
        <>
          <label className="oc-label">Tên squad</label>
          <input className="mushy-input" value={name} maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }} placeholder="VD: Squad Guardrail" />

          <label className="oc-label">Slug</label>
          <input className="mushy-input" value={slug} maxLength={40}
            onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
            placeholder="guardrail" disabled={editing} />

          <label className="oc-label">Squad cha (cây)</label>
          <Select value={parent} onChange={setParent} options={parentOpts}
            placeholder="— Không có (squad gốc) —" />
        </>
      )}

      <label className="oc-label">Giới thiệu / mục tiêu</label>
      <textarea className="mushy-input oc-textarea" value={intro} maxLength={4000}
        onChange={(e) => setIntro(e.target.value)}
        placeholder="Squad này làm gì, mục tiêu, phạm vi…" />

      <button className="mushy-btn mushy-btn--primary mushy-btn--block"
        disabled={!leadOnly && (!name.trim() || slug.trim().length < 2)}
        onClick={() => {
          if (editing) {
            run(() => api.updateSquad(s.id, leadOnly
              ? { intro }
              : { name, intro, parent: parent || null }), 'Đã lưu squad.');
          } else {
            run(() => api.createSquad(activeGroupId, name.trim(),
              slug.trim().toLowerCase(), parent || null, intro), 'Đã tạo squad.');
          }
        }}>
        {editing ? 'Lưu' : 'Tạo squad'}
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function AssignLead({ squad, people, positionOptions, run, close }) {
  const [uid, setUid] = useState('');
  // Mặc định OTHER='Lead' (vì 'Lead' thường không nằm trong positions quản lý)
  const [posSel, setPosSel] = useState(OTHER);
  const [posOther, setPosOther] = useState('Lead');
  const pos = posSel === OTHER ? posOther.trim() : posSel;
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Gán lead · {squad.name}</h3>
      <p className="mushy-section-sub">Lead do admin chỉ định. Lead cũ (nếu có) chuyển thành member, giữ allocation.</p>
      <label className="oc-label">Chọn người</label>
      <MemberSearchSelect value={uid} onChange={setUid} people={people} placeholder="— Chọn member workspace —" />
      <label className="oc-label">Vai trò trong squad</label>
      <Select value={posSel} onChange={setPosSel} options={positionOptions} placeholder="— Chọn vai trò —" />
      {posSel === OTHER && (
        <input className="mushy-input" value={posOther} maxLength={40}
          onChange={(e) => setPosOther(e.target.value)} placeholder="VD: Lead" />
      )}
      <button className="mushy-btn mushy-btn--primary mushy-btn--block" disabled={!uid || !pos}
        onClick={() => run(() => api.assignLead(squad.id, uid, pos), 'Đã gán squad lead.')}>
        Gán lead
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function AddMember({ squad, people, positionOptions, run, close }) {
  const [uid, setUid] = useState('');
  const [posSel, setPosSel] = useState('');
  const [posOther, setPosOther] = useState('');
  const [alloc, setAlloc] = useState('');
  const pos = posSel === OTHER ? posOther.trim() : posSel;
  const allocN = Math.max(0, Math.min(100, parseInt(alloc || '0', 10) || 0));
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Thêm thành viên · {squad.name}</h3>
      <label className="oc-label">Người (member workspace)</label>
      <MemberSearchSelect value={uid} onChange={setUid} people={people} placeholder="— Chọn —" />
      <label className="oc-label">Vai trò trong squad</label>
      <Select value={posSel} onChange={setPosSel} options={positionOptions} placeholder="— Chọn vai trò —" />
      {posSel === OTHER && (
        <input className="mushy-input" value={posOther} maxLength={40}
          onChange={(e) => setPosOther(e.target.value)} placeholder="Nhập vai trò khác…" />
      )}
      <label className="oc-label">% Allocation (0–100)</label>
      <input className="mushy-input" type="number" inputMode="numeric" min={0} max={100}
        value={alloc} onChange={(e) => setAlloc(e.target.value)} placeholder="VD: 50" />
      <button className="mushy-btn mushy-btn--primary mushy-btn--block"
        disabled={!uid || !pos}
        onClick={() => run(() => api.adminSetMember(squad.id, uid, pos, allocN), 'Đã thêm/sửa thành viên.')}>
        Lưu thành viên
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function MyAlloc({ row, squad, positionOptions, run, close }) {
  const known = positionOptions.some((o) => o.value === row.position);
  const [posSel, setPosSel] = useState(known ? row.position : OTHER);
  const [posOther, setPosOther] = useState(known ? '' : row.position);
  const [alloc, setAlloc] = useState(String(row.allocation));
  const pos = posSel === OTHER ? posOther.trim() : posSel;
  const allocN = Math.max(0, Math.min(100, parseInt(alloc || '0', 10) || 0));
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Cập nhật của tôi · {squad.name}</h3>
      <label className="oc-label">Vai trò trong squad</label>
      <Select value={posSel} onChange={setPosSel} options={positionOptions} placeholder="— Chọn vai trò —" />
      {posSel === OTHER && (
        <input className="mushy-input" value={posOther} maxLength={40}
          onChange={(e) => setPosOther(e.target.value)} placeholder="Nhập vai trò khác…" />
      )}
      <label className="oc-label">% Allocation của tôi trong squad này</label>
      <input className="mushy-input" type="number" inputMode="numeric" min={0} max={100}
        value={alloc} onChange={(e) => setAlloc(e.target.value)} />
      <p className="mushy-section-sub">Tổng % mọi squad nên bằng 100%. Khác 100% sẽ được cảnh báo.</p>
      <button className="mushy-btn mushy-btn--primary mushy-btn--block" disabled={!pos}
        onClick={() => run(() => api.setMyAllocation(squad.id, allocN, pos), 'Đã cập nhật.')}>
        Lưu
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function PositionsManager({ ctx, activeGroupId, data, reload, close, dialog }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const admin = ctx.role === 'owner' || ctx.role === 'admin';

  // act: chạy api + reload tại chỗ, KHÔNG đóng modal (quản nhiều vai trò liên tục)
  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { dialog.error('Không thực hiện được', e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Vai trò chức năng (workspace)</h3>
      <p className="mushy-section-sub">Áp dụng chung mọi squad. “Other” là tự nhập, không nằm ở đây.</p>

      {data.positions.length === 0 ? (
        <button className="mushy-btn mushy-btn--primary mushy-btn--block" disabled={busy}
          onClick={() => act(() => api.seedPositions(activeGroupId))}>
          {busy ? <span className="mushy-spinner" /> : 'Tạo bộ mặc định (Product, Tech, Design, QC, Ops)'}
        </button>
      ) : (
        <div className="oc-pos-list">
          {data.positions.map((p) => (
            <div key={p.id} className="oc-pos-row">
              <span>{p.name}{p.is_system ? ' · hệ thống' : ''}</span>
              {admin && (
                <button className="oc-mini-btn" disabled={busy} onClick={async () => {
                  const ok = await dialog.confirm('Xoá vai trò?',
                    `“${p.name}” sẽ bị gỡ khỏi danh sách chọn. Member đang gắn vai trò này vẫn giữ (text).`,
                    { danger: true });
                  if (ok) act(() => api.deletePosition(p.id));
                }}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      {admin && (
        <>
          <label className="oc-label">Thêm vai trò</label>
          <div className="oc-row-inline">
            <input className="mushy-input" value={name} maxLength={40}
              onChange={(e) => setName(e.target.value)} placeholder="VD: Data" />
            <button className="mushy-btn mushy-btn--primary" disabled={busy || !name.trim()}
              onClick={() => act(async () => {
                await api.createPosition(activeGroupId, name.trim());
                setName('');
              })}>Thêm</button>
          </div>
        </>
      )}
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Đóng</button>
    </Scrim>
  );
}

// Sub-3 — activity feed (movement = logs). squad_events vẫn LƯU đủ mọi
// loại; đây CHỈ lọc hiển thị 3 hành động: trở thành lead / gia nhập / rời.
const FEED_SHOW = (ev) =>
  (ev.type === 'lead_changed' && ev.subject_id) // ai đó trở thành squad lead
  || ev.type === 'member_joined'                // ai đó gia nhập squad
  || ev.type === 'member_left';                 // ai đó rời squad

function ActivityFeed({ events, peopleMap, squads }) {
  const [open, setOpen] = useState(false);
  const nameOf = (uid) => personLabel(peopleMap[uid]);
  const sqName = (sid) => squads.find((s) => s.id === sid)?.name;
  // squads = visibleSquads → non-admin không thấy event của squad đã lưu trữ
  const visibleSquadIds = new Set(squads.map((s) => s.id));
  const shown = events.filter((ev) => FEED_SHOW(ev) && visibleSquadIds.has(ev.squad_id));
  const list = open ? shown : shown.slice(0, 5);
  return (
    <div className="oc-feed">
      <button className="oc-feed-head" onClick={() => setOpen((o) => !o)}>
        <span>🕑 Hoạt động gần đây ({shown.length})</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {shown.length === 0 ? (
        <div className="oc-feed-empty">Chưa có hoạt động nào.</div>
      ) : (
        <div className="oc-feed-list">
          {list.map((ev) => (
            <div key={ev.id} className="oc-feed-item">
              <span className="oc-feed-dot" />
              <span className="oc-feed-text">{describeEvent(ev, nameOf, sqName)}</span>
              <span className="oc-feed-time">{timeAgo(ev.created_at)}</span>
            </div>
          ))}
          {!open && shown.length > 5 && (
            <button className="oc-link-btn" onClick={() => setOpen(true)}>
              Xem tất cả ({shown.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Sub-2 — member tự xin vào squad (cho chính mình)
function RequestJoin({ squad, positionOptions, run, close }) {
  const [posSel, setPosSel] = useState('');
  const [posOther, setPosOther] = useState('');
  const [alloc, setAlloc] = useState('');
  const [msg, setMsg] = useState('');
  const pos = posSel === OTHER ? posOther.trim() : posSel;
  const allocN = Math.max(0, Math.min(100, parseInt(alloc || '0', 10) || 0));
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Đăng ký vào · {squad.name}</h3>
      <p className="mushy-section-sub">Squad lead / admin sẽ duyệt yêu cầu.</p>
      <label className="oc-label">Vai trò bạn muốn</label>
      <Select value={posSel} onChange={setPosSel} options={positionOptions} placeholder="— Chọn vai trò —" />
      {posSel === OTHER && (
        <input className="mushy-input" value={posOther} maxLength={40}
          onChange={(e) => setPosOther(e.target.value)} placeholder="Nhập vai trò khác…" />
      )}
      <label className="oc-label">% Allocation (0–100)</label>
      <input className="mushy-input" type="number" inputMode="numeric" min={0} max={100}
        value={alloc} onChange={(e) => setAlloc(e.target.value)} placeholder="VD: 50" />
      <label className="oc-label">Lời nhắn (tuỳ chọn)</label>
      <textarea className="mushy-input oc-textarea" value={msg} maxLength={500}
        onChange={(e) => setMsg(e.target.value)} placeholder="Vì sao bạn muốn vào squad này…" />
      <button className="mushy-btn mushy-btn--primary mushy-btn--block" disabled={!pos}
        onClick={() => run(
          () => api.requestMembership(squad.id, 'join', pos, allocN, msg.trim() || null),
          'Đã gửi yêu cầu đăng ký vào — chờ duyệt.')}>
        Gửi yêu cầu
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

// Ấn vào tên người → hành động liên hệ. Hiện: gọi điện (SĐT công việc đã
// lưu). Tương lai: email, chat duhat… (đang để disabled "sắp có").
function PersonActions({ person, close, dialog, statusByUser, nowTick }) {
  const phone = person?.work_phone && person.work_phone.trim();
  const info = statusByUser?.[person?.user_id] || { status: 'available', message: null, untilMs: null, reason: null, source: 'self', customReasonText: null };
  const meta = getStatusMeta(info.status);
  const remain = formatRemaining(info.untilMs, nowTick);
  const msg = statusMessage(info.status, info.message);
  const reasonText = reasonDisplay(info.reason, info.customReasonText);
  const displayText = msg || reasonText || '';
  const copyText = displayText ? `${meta.label}: ${displayText}${remain ? ` (${remain})` : ''}` : meta.label;

  async function copyStatus() {
    try {
      await navigator.clipboard.writeText(copyText);
      dialog.success('Đã copy', 'Status message đã được sao chép.');
    } catch (e) {
      dialog.error('Không copy được', e?.message || String(e));
    }
  }
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">{personLabel(person)}</h3>
      {person?.job_title && <p className="mushy-section-sub">{person.job_title}</p>}

      <div className="oc-person-status">
        <span className={`oc-status-pill oc-status-pill--${info.status}`}>
          <span className="oc-status-dot" />{meta.label}
        </span>
        {reasonText && <div className="oc-status-reason-badge">{reasonText}</div>}
        {msg && <div className="oc-status-current-msg">{msg}</div>}
        {remain && <div className="oc-status-remaining">{remain}</div>}
      </div>

      <button className="mushy-btn mushy-btn--primary mushy-btn--block"
        disabled={!phone}
        onClick={() => {
          if (!phone) return;
          try { bridge.tel(phone); } catch (e) { dialog.error('Không gọi được', e?.message || String(e)); }
          close();
        }}>
        📞 {phone ? `Gọi ${formatVNPhone(phone)}` : 'Chưa có số điện thoại'}
      </button>

      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={copyStatus}>
        📋 Copy status message
      </button>

      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" disabled>
        ✉️ Email · sắp có
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" disabled>
        💬 Chat (duhat) · sắp có
      </button>

      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Đóng</button>
    </Scrim>
  );
}
