// One-shot: generate a VAPID keypair and print env-var snippet.
//
// Run once (locally) and paste the output into your env vars:
//
//   .env.local for dev
//   Vercel project Settings → Environment Variables for prod
//
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_SUBJECT=mailto:eliel.johnson@gmail.com
//
// VAPID identifies "who is sending the push" to push services so they
// can rate-limit/contact senders. The private key signs each push;
// the public key is also fetched by the PWA (via /api/push/vapid-public-key)
// and passed to pushManager.subscribe() so the browser can verify the
// signature on incoming pushes.
//
// Run: npx tsx scripts/generate-vapid-keys.ts

import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("# Add to .env.local (and Vercel env vars):");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:eliel.johnson@gmail.com`);
