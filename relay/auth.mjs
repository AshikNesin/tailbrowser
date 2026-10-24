// Request gatekeeping shared by HTTP routes and WebSocket upgrades.

import crypto from 'node:crypto';
import { createIpFilter } from './config.mjs';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createAuth({ token, allowList }) {
  const ipAllowed = createIpFilter(allowList);
  // The relay's own Playwright connection (snippet sandbox) dials back into
  // this process. It carries a per-process key so it works regardless of
  // --token / --allow (previously token mode broke every snippet with a 401).
  const internalKey = crypto.randomBytes(24).toString('hex');

  return {
    internalKey,
    isInternal: (url) => safeEqual(url.searchParams.get('internal') || '', internalKey),
    ipAllowed: (req) => ipAllowed(req.socket.remoteAddress),
    tokenOk(req, url) {
      if (!token) return true;
      const header = req.headers.authorization || '';
      return safeEqual(url.searchParams.get('token') || '', token)
        || (header.startsWith('Bearer ') && safeEqual(header.slice('Bearer '.length), token));
    },
  };
}
