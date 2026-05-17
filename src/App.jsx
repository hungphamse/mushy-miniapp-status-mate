import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getContext } from './lib/context.js';
import { bridge } from './lib/bridge.js';
import { useDialog } from './components/Dialog.jsx';
import Select from './components/Select.jsx';
import { listWorkspacePeople, personLabel } from './lib/app/people.js';
import {
  fetchOrgChart, api, slugify, allocationTotals, allocStatus,
} from './lib/app/api.js';
import './App.css';

const OTHER = '__other__';

export default function App() {
  const dialog = useDialog();
  const [ctx, setCtx] = useState(null);
  const [ctxErr, setCtxErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ squads: [], members: [], positions: [], requests: [] });
  const [people, setPeople] = useState([]);
  const [modal, setModal] = useState(null); // { kind, ... }

  useEffect(() => {
    try { setCtx(getContext()); } catch (e) { setCtxErr(e.message); }
  }, []);

  const isAdmin = ctx && (ctx.role === 'owner' || ctx.role === 'admin');

  const reload = useCallback(async () => {
    if (!ctx?.workspaceId) return;
    setLoading(true);
    try {
      const [oc, ppl] = await Promise.all([
        fetchOrgChart(ctx.workspaceId),
        listWorkspacePeople(ctx.workspaceId),
      ]);
      setData(oc);
      setPeople(ppl);
    } catch (e) {
      dialog.error('Không tải được org chart', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [ctx, dialog]);

  useEffect(() => { if (ctx?.workspaceId) reload(); }, [ctx, reload]);

  const peopleMap = useMemo(
    () => Object.fromEntries(people.map((p) => [p.user_id, p])),
    [people],
  );
  const totals = useMemo(() => allocationTotals(data.members), [data.members]);

  // Cây: squads gom theo parent_id
  const childrenOf = useMemo(() => {
    const m = {};
    for (const s of data.squads) {
      const k = s.parent_id || '__root__';
      (m[k] = m[k] || []).push(s);
    }
    for (const k in m) m[k].sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [data.squads]);

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
            {data.squads.length} squad · {data.members.length} thành viên
            {isAdmin ? ' · bạn là admin' : ''}
          </p>
        </div>
        <button className="mushy-btn mushy-btn--ghost oc-refresh" onClick={reload} disabled={loading}>
          {loading ? <span className="mushy-spinner" /> : '↻'}
        </button>
      </header>

      {myInAny && allocStatus(myTotal) !== 'ok' && (
        <div className={`oc-banner oc-banner--${allocStatus(myTotal)}`}>
          Tổng phân bổ của bạn đang là <b>{myTotal}%</b>
          {myTotal > 100 ? ' (quá tải — over-allocated)' : ' (chưa đủ 100% — under-allocated)'}.
          Vào squad của bạn để chỉnh lại %allocation cho khớp 100%.
        </div>
      )}

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
        <div className="oc-tree">
          {roots.map((s) => (
            <SquadNode
              key={s.id} squad={s} depth={0}
              childrenOf={childrenOf} membersOf={membersOf}
              peopleMap={peopleMap} totals={totals}
              requestsBySquad={requestsBySquad} myPending={myPending}
              ctx={ctx} isAdmin={isAdmin} setModal={setModal}
              reload={reload} dialog={dialog}
            />
          ))}
        </div>
      )}

      <footer className="oc-footer">Mushy · org-chart · Sub-1</footer>

      {modal && (
        <ModalHost
          modal={modal} setModal={setModal} close={() => setModal(null)}
          ctx={ctx} data={data} people={people}
          positionOptions={positionOptions} wsMemberOptions={wsMemberOptions}
          dialog={dialog} reload={reload}
        />
      )}
    </div>
  );
}

// ---------------- Squad node (đệ quy, collapsible) ----------------
function SquadNode({ squad, depth, childrenOf, membersOf, peopleMap, totals,
  requestsBySquad, myPending, ctx, isAdmin, setModal, reload, dialog }) {
  const [open, setOpen] = useState(depth < 2);
  const [busy, setBusy] = useState(false);
  const kids = childrenOf[squad.id] || [];
  const mem = (membersOf[squad.id] || []).slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'lead' ? -1 : 1;
    return 0;
  });
  const archived = squad.status === 'archived';
  const isLead = squad.lead_user_id === ctx.userId;
  const canManage = isAdmin || isLead;
  const myActive = mem.some((r) => r.user_id === ctx.userId);
  const myReq = myPending[squad.id];                       // pending của tôi (nếu có)
  const pend = requestsBySquad[squad.id] || [];            // mọi pending của squad

  // Chạy RPC + reload, báo lỗi qua dialog. Không đóng gì (inline).
  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { dialog.error('Không thực hiện được', e?.message || String(e)); }
    finally { setBusy(false); }
  };

  async function reqLeave() {
    const ok = await dialog.confirm('Xin rời squad?',
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
          <button className="oc-collapse" onClick={() => setOpen((o) => !o)}>
            {kids.length || mem.length ? (open ? '▾' : '▸') : '•'}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="oc-squad-title">
              {squad.name}
              {archived && <span className="oc-tag oc-tag--muted">đã lưu trữ</span>}
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
            {mem.length === 0 && <div className="oc-empty-mem">Chưa có thành viên</div>}
            {mem.map((r) => {
              const p = peopleMap[r.user_id];
              const st = allocStatus(totals[r.user_id] || 0);
              const mine = r.user_id === ctx.userId;
              return (
                <div key={r.id} className="oc-mem">
                  <div className="oc-avatar">
                    {p?.avatar_url
                      ? <img src={p.avatar_url} alt="" />
                      : <span>{(personLabel(p)[0] || '?').toUpperCase()}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="oc-mem-name">
                      {r.kind === 'lead' && <span title="Squad lead">👑 </span>}
                      <button className="oc-name-btn"
                        onClick={() => setModal({ kind: 'person', person: p || { user_id: r.user_id } })}>
                        {personLabel(p)}
                      </button>
                      {mine && <span className="oc-tag">bạn</span>}
                    </div>
                    <div className="oc-mem-sub">
                      {r.position}{p?.job_title ? ` · ${p.job_title}` : ''}
                    </div>
                  </div>
                  <span className={`oc-alloc oc-alloc--${st}`} title={`Tổng mọi squad: ${totals[r.user_id] || 0}%`}>
                    {r.allocation}%
                  </span>
                  {mine && (
                    <button className="oc-mini-btn"
                      onClick={() => setModal({ kind: 'my-alloc', squad, row: r })}>✎</button>
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
                  ⏳ Đang chờ duyệt: {myReq.type === 'join' ? 'xin vào' : 'xin rời'}
                </span>
                <button className="oc-mini-btn" disabled={busy} onClick={cancelReq}>Huỷ</button>
              </div>
            ) : myActive ? (
              <button className="oc-link-btn" disabled={busy} onClick={reqLeave}>
                Xin rời squad →
              </button>
            ) : (
              <button className="oc-link-btn" disabled={busy}
                onClick={() => setModal({ kind: 'request-join', squad })}>
                + Xin vào squad
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
                        {r.type === 'join' ? 'xin vào' : 'xin rời'}
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
          reload={reload} dialog={dialog} />
      ))}
    </div>
  );
}

// ---------------- Modal host ----------------
function ModalHost({ modal, setModal, close, ctx, data, people, positionOptions, wsMemberOptions, dialog, reload }) {
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
                👑 Gán squad lead
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
    return <SquadForm modal={modal} data={data} run={run} close={close} ctx={ctx} />;
  }
  if (modal.kind === 'assign-lead') {
    return <AssignLead squad={modal.squad} options={wsMemberOptions} run={run} close={close} />;
  }
  if (modal.kind === 'add-member') {
    return <AddMember squad={modal.squad} wsMemberOptions={wsMemberOptions}
      positionOptions={positionOptions} run={run} close={close} />;
  }
  if (modal.kind === 'my-alloc') {
    return <MyAlloc row={modal.row} squad={modal.squad}
      positionOptions={positionOptions} run={run} close={close} />;
  }
  if (modal.kind === 'positions') {
    return <PositionsManager ctx={ctx} data={data} reload={reload} close={close} dialog={dialog} />;
  }
  if (modal.kind === 'request-join') {
    return <RequestJoin squad={modal.squad} positionOptions={positionOptions}
      run={run} close={close} />;
  }
  if (modal.kind === 'person') {
    return <PersonActions person={modal.person} close={close} dialog={dialog} />;
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

function SquadForm({ modal, data, run, close, ctx }) {
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
            run(() => api.createSquad(ctx.workspaceId, name.trim(),
              slug.trim().toLowerCase(), parent || null, intro), 'Đã tạo squad.');
          }
        }}>
        {editing ? 'Lưu' : 'Tạo squad'}
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function AssignLead({ squad, options, run, close }) {
  const [uid, setUid] = useState('');
  const [pos, setPos] = useState('Lead');
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">Gán lead · {squad.name}</h3>
      <p className="mushy-section-sub">Lead do admin chỉ định. Lead cũ (nếu có) chuyển thành member, giữ allocation.</p>
      <label className="oc-label">Chọn người</label>
      <Select value={uid} onChange={setUid} options={options} placeholder="— Chọn member workspace —" />
      <label className="oc-label">Vai trò hiển thị</label>
      <input className="mushy-input" value={pos} maxLength={40} onChange={(e) => setPos(e.target.value)} />
      <button className="mushy-btn mushy-btn--primary mushy-btn--block" disabled={!uid}
        onClick={() => run(() => api.assignLead(squad.id, uid, pos), 'Đã gán squad lead.')}>
        Gán lead
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

function AddMember({ squad, wsMemberOptions, positionOptions, run, close }) {
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
      <Select value={uid} onChange={setUid} options={wsMemberOptions} placeholder="— Chọn —" />
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

function PositionsManager({ ctx, data, reload, close, dialog }) {
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
          onClick={() => act(() => api.seedPositions(ctx.workspaceId))}>
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
                await api.createPosition(ctx.workspaceId, name.trim());
                setName('');
              })}>Thêm</button>
          </div>
        </>
      )}
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Đóng</button>
    </Scrim>
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
      <h3 className="dialog-title">Xin vào · {squad.name}</h3>
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
          'Đã gửi yêu cầu xin vào — chờ duyệt.')}>
        Gửi yêu cầu
      </button>
      <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={close}>Huỷ</button>
    </Scrim>
  );
}

// Ấn vào tên người → hành động liên hệ. Hiện: gọi điện (SĐT công việc đã
// lưu). Tương lai: email, chat duhat… (đang để disabled "sắp có").
function PersonActions({ person, close, dialog }) {
  const phone = person?.work_phone && person.work_phone.trim();
  return (
    <Scrim close={close}>
      <h3 className="dialog-title">{personLabel(person)}</h3>
      {person?.job_title && <p className="mushy-section-sub">{person.job_title}</p>}

      <button className="mushy-btn mushy-btn--primary mushy-btn--block"
        disabled={!phone}
        onClick={() => {
          if (!phone) return;
          try { bridge.tel(phone); } catch (e) { dialog.error('Không gọi được', e?.message || String(e)); }
          close();
        }}>
        📞 {phone ? `Gọi ${phone}` : 'Chưa có số điện thoại'}
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
