import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Read at build time for rewrites; see docs/adr/0001-monorepo-tooling.md. In staging, Caddy routes
// /api/* to the API directly, so this rewrite only serves local dev.
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Self-contained server (apps/web/Dockerfile); tracing from the repo root picks up workspace packages.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // Local two-domain demo (docs/platform/web-shell.md): durby.localhost, partner-demo.localhost.
  allowedDevOrigins: ['*.localhost'],
  // `next upgrade --agent=security`: keep to security patch releases.
  experimental: { agentUpgrade: 'security' },
  rewrites() {
    return Promise.resolve([{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }]);
  },
};

export default nextConfig;
