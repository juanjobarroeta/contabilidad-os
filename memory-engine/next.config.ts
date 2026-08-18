import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Standalone app: nothing here may reach into the parent contabilidad-os tree.
  outputFileTracingRoot: __dirname,
}

export default nextConfig
