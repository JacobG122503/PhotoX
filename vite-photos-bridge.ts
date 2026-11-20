// Vite plugin: exposes the Apple Photos helper (helper/PhotosBridge.swift) to the page at /__photos/*.
// It starts the helper on first use, adds the secret token, and passes requests and responses
// through (including Range requests for video). The browser never sees the token, and the helper
// only listens on 127.0.0.1.
import type { Connect, Plugin } from 'vite';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Info = { port: number; token: string };
const INFO = join(homedir(), 'Library/Application Support/PhotoX/bridge.json');
const PREFIX = '/__photos';
const TOKEN_HEADER = 'X-PhotoX-Token';
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];

function readInfo(): Info | null {
  try {
    const j = JSON.parse(readFileSync(INFO, 'utf8'));
    return typeof j.port === 'number' && typeof j.token === 'string' ? j : null;
  } catch {
    return null;
  }
}

function ping(info: Info): Promise<boolean> {
  return new Promise((done) => {
    const r = request({ host: '127.0.0.1', port: info.port, path: '/status', headers: { [TOKEN_HEADER]: info.token }, timeout: 1500 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    r.on('error', () => done(false));
    r.on('timeout', () => { r.destroy(); done(false); });
    r.end();
  });
}

export function photosBridge(): Plugin {
  let appPath = '';
  let launching: Promise<Info> | null = null;
  let current: Info | null = null;

  const launch = () =>
    (launching ??= (async () => {
      if (process.platform !== 'darwin') throw new Error('The Photos helper only runs on macOS');
      if (!existsSync(appPath)) throw new Error('The Photos helper is not built. Run `npm run dev` again.');
      const old = readInfo();
      if (old && (await ping(old))) return old;
      // -g: launch in the background without stealing focus
      await new Promise<void>((res, rej) => execFile('open', ['-g', appPath], (e) => (e ? rej(e) : res())));
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const info = readInfo();
        if (info && (info.token !== old?.token || i > 8) && (await ping(info))) return info;
      }
      throw new Error('The Photos helper did not start');
    })().finally(() => { launching = null; }));

  const ensure = async (fresh = false) => {
    if (!fresh && current) return current;
    current = await launch();
    return current;
  };

  const forward = (info: Info, path: string, req: IncomingMessage, res: ServerResponse, retry: () => void) => {
    let gotResponse = false;
    const headers: Record<string, string> = { [TOKEN_HEADER]: info.token };
    if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
    const up = request({ host: '127.0.0.1', port: info.port, path, method: 'GET', headers }, (r) => {
      gotResponse = true;
      if (r.statusCode === 401) { r.resume(); return retry(); } // helper restarted with a new token
      const out: Record<string, string> = {};
      for (const h of PASS_HEADERS) {
        const v = r.headers[h];
        if (typeof v === 'string') out[h] = v;
      }
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.on('error', () => { if (!gotResponse) retry(); else res.destroy(); });
    // the page navigated away, or an image scrolled off the map and its request was dropped
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    up.end();
  };

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith(PREFIX + '/')) return next();
    const path = req.url.slice(PREFIX.length);
    const fail = (status: number, error: string) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };
    let tries = 0;
    const attempt = (fresh: boolean) => {
      ensure(fresh)
        .then((info) => forward(info, path, req, res, () => (++tries < 2 ? attempt(true) : fail(502, 'Lost connection to the Photos helper'))))
        .catch((e: Error) => fail(501, e.message));
    };
    attempt(false);
  };

  return {
    name: 'photox-photos-bridge',
    configResolved(c) { appPath = resolve(c.root, 'helper/build/PhotoX Photos.app'); },
    configureServer(s) { s.middlewares.use(middleware); },
    configurePreviewServer(s) { s.middlewares.use(middleware); },
  };
}
