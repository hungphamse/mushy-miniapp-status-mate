// Searchable member picker — thay <Select> cho AddMember + AssignLead.
// Hiển thị tên + email công ty (fallback email cá nhân + sđt) trong mỗi
// option. Search box ở đỉnh panel: filter theo name + work_email +
// personal_email + work_phone (lowercase + strip phone separators).
//
// App-specific (không phải shared Select.jsx) — đặt trong src/components/
// nhưng KHÔNG bị sync-template overwrite vì là file của app, không trùng
// với template's Select.jsx.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { personLabel, personEmail } from '../lib/app/people.js';

const PANEL_MAX_H = 360;
const PANEL_GAP = 6;

function norm(s) { return (s || '').toString().toLowerCase().trim(); }
function normPhone(s) { return norm(s).replace(/[\s.+\-()]/g, ''); }

export default function MemberSearchSelect({ value, onChange, people, placeholder = '— Chọn —', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [direction, setDirection] = useState('down');
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(() => people.find((p) => p.user_id === value), [people, value]);

  // Filter list theo query — match name/email/phone, normalize lowercase.
  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return people;
    const qPhone = normPhone(query);
    return people.filter((p) => {
      if (norm(p.full_name).includes(q)) return true;
      if (norm(p.job_title).includes(q)) return true;
      if (norm(p.work_email).includes(q)) return true;
      if (norm(p.personal_email).includes(q)) return true;
      if (qPhone && normPhone(p.work_phone).includes(qPhone)) return true;
      return false;
    });
  }, [people, query]);

  useEffect(() => { setHighlight(-1); }, [query]);

  // Click ngoài đóng
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Direction flip (down/up) theo viewport
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    function recalc() {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - PANEL_GAP;
      const spaceAbove = rect.top - PANEL_GAP;
      if (spaceBelow < PANEL_MAX_H && spaceAbove > spaceBelow) setDirection('up');
      else setDirection('down');
    }
    recalc();
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, true);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [open]);

  // Autofocus search khi mở
  useEffect(() => {
    if (open && inputRef.current) {
      // Defer 1 tick để input mount xong
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 0);
    }
  }, [open]);

  // Esc đóng + Arrow/Enter nav
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); setQuery(''); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter' && highlight >= 0) {
        e.preventDefault();
        const p = filtered[highlight];
        if (p) pick(p.user_id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, highlight, filtered]);

  function pick(uid) {
    onChange(uid);
    setOpen(false);
    setQuery('');
  }

  // Label trigger: name + job_title nếu có
  const triggerLabel = selected
    ? personLabel(selected) + (selected.job_title ? ` · ${selected.job_title}` : '')
    : placeholder;

  return (
    <div className="mushy-select" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`mushy-select-trigger ${open ? 'mushy-select-trigger--open' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`mushy-select-value ${!selected ? 'mushy-select-placeholder' : ''}`}>
          {triggerLabel}
        </span>
        <span className={`mushy-select-chevron ${open ? 'mushy-select-chevron--open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className={`mushy-select-panel mushy-select-panel--${direction}`} role="listbox">
          <div className="ms-search-wrap">
            <span className="ms-search-icon">🔍</span>
            <input
              ref={inputRef}
              type="text"
              className="ms-search-input"
              placeholder="Tìm tên, email, SĐT…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            {query.length > 0 && (
              <button type="button" className="ms-search-clear" onClick={() => setQuery('')} aria-label="Xoá">✕</button>
            )}
          </div>
          <ul className="ms-list" role="listbox">
            {filtered.length === 0 ? (
              <li className="mushy-select-empty">Không có ai khớp “{query}”.</li>
            ) : filtered.map((p, i) => {
              const email = personEmail(p);
              const isSelected = p.user_id === value;
              return (
                <li
                  key={p.user_id}
                  role="option"
                  aria-selected={isSelected}
                  className={`mushy-select-option ms-option ${isSelected ? 'mushy-select-option--selected' : ''} ${i === highlight ? 'mushy-select-option--highlight' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(p.user_id)}
                >
                  <div className="ms-option-body">
                    <div className="ms-option-name">
                      {personLabel(p)}
                      {p.job_title ? <span className="ms-option-jt"> · {p.job_title}</span> : null}
                    </div>
                    {email ? (
                      <div className="ms-option-sub">{email}</div>
                    ) : p.work_phone ? (
                      <div className="ms-option-sub">📞 {p.work_phone}</div>
                    ) : (
                      <div className="ms-option-sub ms-option-sub--muted">(chưa có email)</div>
                    )}
                  </div>
                  {isSelected && <span className="mushy-select-check">✓</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
