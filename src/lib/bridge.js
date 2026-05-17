// JS Bridge: Mini-app ↔ Shell native.
// Khi không có Shell (DEV trong browser), tự động dùng mock.
//
// Sử dụng:
//   const loc = await callNative('GET_LOCATION');
//   const photo = await callNative('OPEN_CAMERA', { quality: 0.8 });
//
// Hoặc helper typed (recommended):
//   import { bridge } from './lib/bridge.js';
//   await bridge.share({ message: 'Hello', url: 'https://...' });
//   await bridge.haptic('success');
//   await bridge.tel('0901234567');
//   const ok = await bridge.biometric({ promptMessage: 'Xác thực' });

import { isInShell } from './context.js';

// Timeout: 10s cho op nhanh, 5 phút cho op tương tác (user loay hoay tay lâu).
// Override qua opts.timeout nếu cần.
const DEFAULT_TIMEOUT_MS = 10_000;
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
const INTERACTIVE_TYPES = new Set(['OPEN_CAMERA', 'PICK_FILE', 'SCAN_QR', 'BIOMETRIC', 'SHARE']);
const pending = new Map();
let nextId = 1;

// Shell sẽ gọi `window.__bridgeResolve(id, result, error)` khi xong
if (typeof window !== 'undefined') {
  window.__bridgeResolve = (id, result, error) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(new Error(error)) : p.resolve(result);
  };
}

export function callNative(type, payload = {}, opts = {}) {
  if (!isInShell()) return mock(type, payload);

  const timeoutMs =
    opts.timeout ?? (INTERACTIVE_TYPES.has(type) ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Bridge timeout: ${type}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, type, payload }));
  });
}

// Typed helpers — recommended. Tự fallback browser khi không có Shell:
//   - tel/url: dùng window.location = `tel:...` / window.open(url)
//   - share: dùng navigator.share (mobile) hoặc clipboard fallback
//   - haptic: no-op trong browser
export const bridge = {
  location: () => callNative('GET_LOCATION'),
  camera: (opts) => callNative('OPEN_CAMERA', opts),
  pickFile: (opts) => callNative('PICK_FILE', opts),
  pushNotification: (opts) => callNative('PUSH_NOTIFICATION', opts),

  async tel(phone) {
    if (!isInShell()) {
      // Browser fallback: anchor tel:. Desktop: thường không action gì.
      window.location.href = `tel:${phone}`;
      return { opened: true };
    }
    return callNative('OPEN_TEL', { phone });
  },

  async openUrl(url) {
    if (!isInShell()) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { opened: true };
    }
    return callNative('OPEN_URL', { url });
  },

  async share({ title, message, url } = {}) {
    if (!isInShell()) {
      // Browser fallback: Web Share API (mobile) hoặc clipboard.
      if (navigator.share) {
        try {
          await navigator.share({ title, text: message, url });
          return { shared: true, action: 'web-share' };
        } catch (e) {
          if (e.name === 'AbortError') return { shared: false, action: 'dismissed' };
          throw e;
        }
      }
      const text = [message, url].filter(Boolean).join('\n');
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return { shared: true, action: 'clipboard' };
      }
      throw new Error('Browser không hỗ trợ share');
    }
    return callNative('SHARE', { title, message, url });
  },

  // type: 'light'|'medium'|'heavy'|'success'|'warning'|'error'|'selection'
  async haptic(type = 'medium') {
    if (!isInShell()) {
      // Browser navigator.vibrate dài/ngắn theo intensity. Có gì tốt nấy.
      if (navigator.vibrate) navigator.vibrate(type === 'heavy' ? 30 : type === 'light' ? 5 : 15);
      return { ok: true };
    }
    return callNative('HAPTIC', { type });
  },

  scanQr: () => callNative('SCAN_QR'),

  // Browser không có biometric — luôn fail rõ ràng để mini-app fallback password.
  async biometric(opts = {}) {
    if (!isInShell()) throw new Error('Biometric chỉ chạy trong Shell native');
    return callNative('BIOMETRIC', opts);
  },

  refreshToken: () => callNative('REFRESH_TOKEN'),
};

// ---------- Mocks (DEV only, low-level callNative path) ----------
async function mock(type, payload) {
  console.log('[bridge:mock]', type, payload);
  await sleep(200);
  switch (type) {
    case 'GET_LOCATION':
      return { lat: 10.7769, lng: 106.7009, accuracy: 12 };
    case 'OPEN_CAMERA':
      return { uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', width: 1, height: 1 };
    case 'PICK_FILE':
      return { name: 'mock.txt', size: 12, mimeType: 'text/plain', uri: 'mock://file' };
    case 'PUSH_NOTIFICATION':
      console.log('[mock push]', payload.title, '—', payload.body);
      return { scheduled: true };
    case 'OPEN_TEL':
      console.log('[mock tel]', payload.phone);
      return { opened: true };
    case 'OPEN_URL':
      console.log('[mock open-url]', payload.url);
      return { opened: true };
    case 'SHARE':
      console.log('[mock share]', payload);
      return { shared: true, action: 'mock' };
    case 'HAPTIC':
      console.log('[mock haptic]', payload.type);
      return { ok: true };
    case 'SCAN_QR':
      // Mock: trả giá trị giả để dev test flow downstream.
      console.log('[mock scan-qr] returning fake');
      return { data: 'MOCK-QR-DATA', type: 'qr' };
    case 'BIOMETRIC':
      console.log('[mock biometric] auto-success');
      return { success: true };
    case 'REFRESH_TOKEN':
      throw new Error('REFRESH_TOKEN bridge chỉ chạy trong Shell. Dev local: npm run dev:token.');
    default:
      throw new Error(`Bridge mock chưa hỗ trợ type: ${type}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
