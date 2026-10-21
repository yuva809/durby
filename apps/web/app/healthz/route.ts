// Liveness of the web server itself (Docker healthcheck). Does not call the API.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
