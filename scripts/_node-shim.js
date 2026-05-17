// Node 20 chưa có WebSocket native — polyfill cho @supabase/realtime-js.
// Import file này ở đầu mọi script Node trong repo.
import ws from 'ws';
if (!globalThis.WebSocket) globalThis.WebSocket = ws;
