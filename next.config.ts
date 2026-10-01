import type { NextConfig } from "next";

// Storage domains the CSP needs to allow, beyond 'self'. Empty by default
// (local storage provider serves everything same-origin under
// /uploads/); set these once a real object-storage provider is wired up
// (see lib/storage.ts) so photos, music, and QR codes hosted there still
// load. Never includes the private bucket — nothing private is ever
// loaded directly by the browser; see the admin screenshot route.
const STORAGE_ORIGIN = process.env.STORAGE_PUBLIC_BASE_URL
  ? new URL(process.env.STORAGE_PUBLIC_BASE_URL).origin
  : "";

function csp() {
  const imgAndMediaSrc = ["'self'", "data:", STORAGE_ORIGIN].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    `img-src ${imgAndMediaSrc}`,
    `media-src ${imgAndMediaSrc}`,
    // Next.js's own hydration bootstrap needs 'unsafe-inline' here unless
    // a per-request nonce is wired through middleware + the root layout —
    // a stricter, nonce-based policy is the ideal but genuinely risks
    // breaking hydration if the nonce plumbing is even slightly wrong,
    // and that isn't something that can be verified without actually
    // running the app. This is a deliberate, documented relaxation, not
    // an oversight — tighten this once there's a real deployment to test
    // a nonce-based policy against.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp() },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // microphone=(self) — the public surprise page's opt-in "blow the
  // candles" mic detection (see useBlowDetector.ts) needs this; everything
  // else the app doesn't use is explicitly denied rather than left
  // default-permissive.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
  // Only meaningful over HTTPS (browsers ignore it over plain HTTP in
  // dev), so safe to always send. No `preload` directive — that's a
  // separate, harder-to-reverse commitment (submission to browsers'
  // built-in preload list) left for a deliberate later decision, not
  // something to opt into by default here.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
