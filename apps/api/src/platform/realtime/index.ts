// Public API of platform/realtime (docs/platform/realtime.md, ADR 0044): modules publish hints from
// their outbox handlers and serve their own stream route.
export { type HubListener, RealtimeHub } from './realtime-hub';
export { RealtimePublisher } from './realtime-publisher';
export { MAX_STREAMS_PER_SESSION, RealtimeStreams } from './realtime-streams';
export { RealtimeModule } from './realtime.module';
export { realtimeChannel, SSE_HEADERS, SSE_PING, sseEvent } from './sse';
