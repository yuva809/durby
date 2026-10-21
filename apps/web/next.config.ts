import type { NextConfig } from 'next';

// Read at build time for rewrites; see docs/adr/0001-monorepo-tooling.md (revisit in 0.4).
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  rewrites() {
    return Promise.resolve([{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }]);
  },
};

export default nextConfig;
