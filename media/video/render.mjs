#!/usr/bin/env node
// Render composition.html to an MP4, frame by frame (deterministic: each
// frame is render(t) for its exact timestamp, then piped into ffmpeg).
//
// Run: node media/video/render.mjs                 -> media/tailbrowser.mp4 + poster (also copied to docs/assets/)
//      node media/video/render.mjs --stills 3,9,25 -> PNG stills for review
// Needs Chromium (CHROME_BIN or Playwright's cache) and ffmpeg with libx264.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flagReader } from '../../lib/args.mjs';
import { findChromium } from '../../lib/find-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..');
const FPS = 30;
const flag = flagReader(process.argv.slice(2));
const stills = flag('stills', null);

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(HERE, 'composition.html')).href);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => DURATION);
const frameAt = async (t, type = 'jpeg') => {
  await page.evaluate((s) => render(s), t);
  return page.screenshot(type === 'png' ? { type } : { type, quality: 94 });
};

if (stills) {
  const dir = path.join(OUT_DIR, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of String(stills).split(',').map(Number)) {
    const file = path.join(dir, `t${String(t).padStart(5, '0')}.png`);
    fs.writeFileSync(file, await frameAt(t, 'png'));
    console.log('  ', path.relative(process.cwd(), file));
  }
} else {
  const out = path.join(OUT_DIR, 'tailbrowser.mp4');
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    const jpeg = await frameAt(i / FPS);
    if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (i % FPS === 0) process.stdout.write(`\r  rendering ${Math.round((i / frames) * 100)}%`);
  }
  ffmpeg.stdin.end();
  const code = await new Promise((r) => ffmpeg.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  // poster: the demo moment with the result on screen
  fs.writeFileSync(path.join(OUT_DIR, 'tailbrowser-poster.jpg'), await frameAt(27.5));
  // the website (docs/) serves its own copies, plus a VP9 WebM for browsers
  // without H.264 (open-source Chromium builds)
  const site = path.resolve(HERE, '../../docs/assets');
  fs.mkdirSync(site, { recursive: true });
  for (const f of ['tailbrowser.mp4', 'tailbrowser-poster.jpg']) fs.copyFileSync(path.join(OUT_DIR, f), path.join(site, f));
  const webm = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34',
    '-row-mt', '1', '-deadline', 'good', path.join(site, 'tailbrowser.webm')], { stdio: 'inherit' });
  if ((await new Promise((r) => webm.on('close', r))) !== 0) throw new Error('webm encode failed');
  console.log(`\r  ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${duration}s)`);
}
await browser.close();
