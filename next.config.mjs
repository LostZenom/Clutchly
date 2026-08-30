/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ship the web app with the desktop overlay: `next build` emits
  // .next/standalone so Electron can boot the site itself on a chosen port.
  output: "standalone",
  images: {
    // Steam CDN avatars + external emoji/proxy images
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.akamai.steamstatic.com",
      },
      {
        protocol: "https",
        hostname: "cdn.akamai.steamstatic.com",
      },
      {
        protocol: "https",
        hostname: "steamcdn-a.akamaihd.net",
      },
      {
        protocol: "https",
        hostname: "avatars.cloudflare.steamstatic.com",
      },
      {
        protocol: "http",
        hostname: "media.steampowered.com",
      },
    ],
  },
  // Native .dem files are never bundled to the client; the Rust-based demo
  // parser ships a prebuilt .node binary, so keep it external to webpack.
  experimental: {
    serverComponentsExternalPackages: ["@laihoe/demoparser2"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({
        "@laihoe/demoparser2": "commonjs @laihoe/demoparser2",
        "@laihoe/demoparser2-win32-x64-msvc": "commonjs @laihoe/demoparser2-win32-x64-msvc",
        "steam-user": "commonjs steam-user",
        "node-cs2": "commonjs node-cs2",
        "node-cs2/language.js": "commonjs node-cs2/language.js",
        "node-cs2/protobufs/generated/_load.js": "commonjs node-cs2/protobufs/generated/_load.js",
        "bytebuffer": "commonjs bytebuffer",
        "steamid": "commonjs steamid",
      });
    }
    return config;
  },
};

export default nextConfig;