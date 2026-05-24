// Settings modal cho Org Group (mig 004+007):
// - List groups ws hiện tại đang subscribe
// - Ws owner/admin: Tạo mới + nhập mã share
// - Owner group: gen share code, edit name/desc, soft delete
// - Non-origin ws: Rời group (origin KHÔNG rời được)

import React, { useEffect, useState } from 'react';
import { useDialog } from './Dialog.jsx';
import { getContext } from '../lib/context.js';
import {
  listOrgGroups,
  createOrgGroup,
  updateOrgGroup,
  deleteOrgGroup,
  generateShareCode,
  redeemShareCode,
  unshareFromWorkspace,
  listWorkspacesForGroup,
} from '../lib/app/org-groups.js';

export default function OrgGroupSettingsModal({ onClose, onChange }) {
  const dialog = useDialog();
  const ctx = getContext();
  const isWsAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const [groups, setGroups] = useState(null);
  const [view, setView] = useState({ kind: 'list' });

  async function reload() {
    try { setGroups(await listOrgGroups()); }
    catch (e) { dialog.error('Không tải được org groups', e.message); }
  }
  useEffect(() => { reload(); }, []);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">🏢 Org Groups</h3>
        <p className="dialog-body" style={{ marginTop: 4 }}>
          Cấu trúc tổ chức dùng chung trong group. Workspace đã subscribe group → mọi thành viên thấy + cùng cộng tác.
        </p>

        {view.kind === 'list' && (
          <>
            {groups === null ? (
              <div style={{ padding: 20, textAlign: 'center' }}><span className="mushy-spinner" /></div>
            ) : groups.length === 0 ? (
              <div className="mushy-code" style={{ marginTop: 12 }}>
                Workspace chưa subscribe org group nào.
                {isWsAdmin
                  ? ' Tạo mới hoặc nhập mã share để bắt đầu.'
                  : ' Chờ admin tạo / share group.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                {groups.map((g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    onEdit={() => setView({ kind: 'edit', id: g.id })}
                    onChange={() => { reload(); onChange?.(); }}
                  />
                ))}
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 16, flexDirection: 'column', gap: 8 }}>
              {isWsAdmin && (
                <>
                  <button className="mushy-btn mushy-btn--primary mushy-btn--block"
                    onClick={() => setView({ kind: 'create' })}>
                    + Tạo org group mới
                  </button>
                  <button className="mushy-btn mushy-btn--ghost mushy-btn--block"
                    onClick={() => setView({ kind: 'redeem' })}>
                    🔑 Nhập mã share
                  </button>
                </>
              )}
              <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={onClose}>
                Đóng
              </button>
            </div>
          </>
        )}

        {view.kind === 'create' && (
          <CreateGroupForm
            onCancel={() => setView({ kind: 'list' })}
            onCreated={() => { setView({ kind: 'list' }); reload(); onChange?.(); }}
          />
        )}
        {view.kind === 'edit' && (
          <EditGroupForm
            group={groups?.find((x) => x.id === view.id)}
            onCancel={() => setView({ kind: 'list' })}
            onSaved={() => { setView({ kind: 'list' }); reload(); onChange?.(); }}
          />
        )}
        {view.kind === 'redeem' && (
          <RedeemCodeForm
            onCancel={() => setView({ kind: 'list' })}
            onJoined={() => { setView({ kind: 'list' }); reload(); onChange?.(); }}
          />
        )}
      </div>
    </div>
  );
}

function GroupRow({ group, onEdit, onChange }) {
  const dialog = useDialog();
  const ctx = getContext();
  const isOwner = group.owner_user_id === ctx.userId;
  const isOriginWs = group.workspace_id === ctx.workspaceId;
  const isWsAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const [busy, setBusy] = useState(false);
  const [shareCode, setShareCode] = useState(null);
  const [wsList, setWsList] = useState(null);

  async function gen() {
    setBusy(true);
    try { const sc = await generateShareCode(group.id); setShareCode(sc); }
    catch (e) { dialog.error('Không gen được mã', e.message); }
    finally { setBusy(false); }
  }
  async function showWs() {
    if (wsList) { setWsList(null); return; }
    try { setWsList(await listWorkspacesForGroup(group.id)); }
    catch (e) { dialog.error('Không tải được danh sách workspace', e.message); }
  }
  async function removeFromWs() {
    if (isOriginWs) {
      dialog.error('Không rời được', 'Workspace này là origin của group. Origin không thể unshare. Owner cần xoá hẳn group nếu muốn dừng.');
      return;
    }
    const ok = await dialog.confirm(
      'Rời org group',
      `Workspace này sẽ KHÔNG còn thấy data org chart của "${group.name}". Tiếp tục?`,
      { danger: true, confirmLabel: 'Rời', cancelLabel: 'Huỷ' }
    );
    if (!ok) return;
    try { await unshareFromWorkspace(group.id); onChange?.(); }
    catch (e) { dialog.error('Không rời được workspace', e.message); }
  }

  return (
    <div className="mushy-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ flex: 1 }}>{group.name}</strong>
        {isOriginWs && <span className="mushy-status mushy-status--ok"><span className="mushy-status-dot" />Origin</span>}
        {isOwner && !isOriginWs && <span className="mushy-status mushy-status--ok"><span className="mushy-status-dot" />Owner</span>}
      </div>
      {group.description && <div style={{ fontSize: 13, marginTop: 4, color: 'var(--muted)' }}>{group.description}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {isWsAdmin && (
          <>
            <button className="mushy-btn mushy-btn--ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={gen} disabled={busy}>
              🔑 Gen mã share
            </button>
            <button className="mushy-btn mushy-btn--ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={showWs}>
              {wsList ? 'Ẩn workspace' : '👥 Workspace đã share'}
            </button>
          </>
        )}
        {isOwner && (
          <button className="mushy-btn mushy-btn--ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={onEdit}>
            ✎ Sửa
          </button>
        )}
        {isWsAdmin && !isOriginWs && (
          <button className="mushy-btn mushy-btn--ghost" style={{ fontSize: 12, padding: '6px 10px', color: 'var(--danger, #d33)' }} onClick={removeFromWs}>
            Rời workspace này
          </button>
        )}
      </div>

      {shareCode && (
        <div className="mushy-code" style={{ marginTop: 10, textAlign: 'center', fontSize: 18, letterSpacing: 4 }}>
          <strong>{shareCode.code}</strong>
          <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>
            Hết hạn {shareCode.expires_at ? new Date(shareCode.expires_at).toLocaleString('vi-VN') : 'không giới hạn'}
          </div>
        </div>
      )}
      {wsList && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {wsList.length === 0 ? <em>Chưa share với ws nào</em> :
            wsList.map((w) => <div key={w.workspace_id}>• {w.name}</div>)}
        </div>
      )}
    </div>
  );
}

function CreateGroupForm({ onCancel, onCreated }) {
  const dialog = useDialog();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (name.trim().length < 2) { dialog.error('Tên ngắn', 'Tên cần ≥ 2 ký tự'); return; }
    setBusy(true);
    try {
      await createOrgGroup({ name: name.trim(), description: description.trim() || null });
      onCreated();
    } catch (e) {
      dialog.error('Tạo thất bại', e.message);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <label className="mushy-label">Tên *</label>
        <input className="mushy-input" placeholder="vd: VinSmart Tech Org"
          value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label className="mushy-label">Mô tả (tuỳ chọn)</label>
        <textarea className="mushy-input" rows={2}
          value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="form-actions">
        <button className="mushy-btn mushy-btn--ghost" onClick={onCancel} disabled={busy}>Huỷ</button>
        <button className="mushy-btn mushy-btn--primary" onClick={submit} disabled={busy}>
          {busy ? 'Đang tạo…' : '+ Tạo'}
        </button>
      </div>
    </div>
  );
}

function EditGroupForm({ group, onCancel, onSaved }) {
  const dialog = useDialog();
  const [name, setName] = useState(group?.name || '');
  const [description, setDescription] = useState(group?.description || '');
  const [busy, setBusy] = useState(false);

  if (!group) return null;

  async function save() {
    setBusy(true);
    try {
      await updateOrgGroup(group.id, { name: name.trim(), description: description.trim() || null });
      onSaved();
    } catch (e) { dialog.error('Lưu thất bại', e.message); }
    finally { setBusy(false); }
  }
  async function softDelete() {
    const ok = await dialog.confirm(
      `Xoá "${group.name}"?`,
      `Mọi squad + member + request của group này sẽ bị soft-delete (data còn ở DB). Nhập slug "${group.slug}" để xác nhận.`,
      { danger: true, requireType: group.slug, confirmLabel: 'Xoá', cancelLabel: 'Huỷ' }
    );
    if (!ok) return;
    setBusy(true);
    try { await deleteOrgGroup(group.id, group.slug); onSaved(); }
    catch (e) { dialog.error('Xoá thất bại', e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <label className="mushy-label">Tên</label>
        <input className="mushy-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label className="mushy-label">Mô tả</label>
        <textarea className="mushy-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="form-actions" style={{ flexDirection: 'column', gap: 8 }}>
        <button className="mushy-btn mushy-btn--primary mushy-btn--block" onClick={save} disabled={busy}>
          {busy ? 'Đang lưu…' : 'Lưu'}
        </button>
        <button className="mushy-btn mushy-btn--ghost mushy-btn--block" onClick={onCancel} disabled={busy}>Huỷ</button>
        <button className="mushy-btn mushy-btn--ghost mushy-btn--block" style={{ color: 'var(--danger, #d33)' }}
          onClick={softDelete} disabled={busy}>
          Xoá org group
        </button>
      </div>
    </div>
  );
}

function RedeemCodeForm({ onCancel, onJoined }) {
  const dialog = useDialog();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!/^\d{4}$/.test(code)) { dialog.error('Mã không hợp lệ', 'Mã share là 4 chữ số.'); return; }
    setBusy(true);
    try {
      const g = await redeemShareCode(code);
      dialog.success('Đã share', `Workspace đã subscribe "${g.name}". Mọi thành viên thấy ngay.`);
      onJoined();
    } catch (e) {
      const msg = /INVALID_OR_EXPIRED_CODE/.test(e.message) ? 'Mã sai hoặc đã hết hạn.' : e.message;
      dialog.error('Nhập mã thất bại', msg);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p className="dialog-body">Nhập mã 4 chữ số do thành viên của org group cấp:</p>
      <input
        className="mushy-input"
        style={{ textAlign: 'center', fontSize: 28, letterSpacing: 8, fontWeight: 700 }}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
        placeholder="0000"
        autoFocus
        inputMode="numeric"
        maxLength={4}
      />
      <div className="form-actions" style={{ marginTop: 12 }}>
        <button className="mushy-btn mushy-btn--ghost" onClick={onCancel} disabled={busy}>Huỷ</button>
        <button className="mushy-btn mushy-btn--primary" onClick={submit} disabled={busy || code.length !== 4}>
          {busy ? 'Đang xử lý…' : 'Subscribe'}
        </button>
      </div>
    </div>
  );
}
