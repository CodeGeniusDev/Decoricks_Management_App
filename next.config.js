/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow cross-origin requests from localhost for development
  allowedDevOrigins: ['localhost:127.0.0.1', 'localhost::1'],
}

module.exports = nextConfig
