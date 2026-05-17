// Context injection từ Shell → Mini-app
// Shell inject `window.__APP_CONTEXT__` trước khi load WebView.
// Khi chạy DEV trong browser thường, fallback sang biến VITE_DEV_*.

export function getContext() {
  if (typeof window !== 'undefined' && window.__APP_CONTEXT__) {
    return window.__APP_CONTEXT__;
  }
  if (import.meta.env.DEV) {
    return {
      token:       import.meta.env.VITE_DEV_TOKEN,
      workspaceId: import.meta.env.VITE_DEV_WORKSPACE_ID,
      userId:      import.meta.env.VITE_DEV_USER_ID,
      role:        import.meta.env.VITE_DEV_ROLE || 'admin',
      workspaceSlug: 'dev',
    };
  }
  throw new Error('Không tìm thấy APP_CONTEXT — mini-app phải chạy trong Shell hoặc bật DEV mode');
}

export function isInShell() {
  return typeof window !== 'undefined' && !!window.ReactNativeWebView;
}
