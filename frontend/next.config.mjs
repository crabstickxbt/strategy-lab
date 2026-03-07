/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  experimental: {
    webpackBuildWorker: false,
  },
};

export default nextConfig;
