import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const VK_LBUTTON = 0x01;
const WS_THICKFRAME = 0x00040000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TOPMOST = 0x00000008;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const SW_RESTORE = 9;
const SW_MAXIMIZE = 3;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const COMPACT_WIDTH = 425;
const ANIMATION_MS = 240;

/** Load the Win32 bindings the desktop already ships, so window work never spawns a process. */
function loadWin32() {
  // The desktop build ships koffi unpacked next to the executable; fall back to a
  // profile-installed copy and finally to normal module resolution.
  const exeDir = dirname(process.execPath);
  const candidates = [
    join(exeDir, 'resources', 'app.asar.unpacked', 'node_modules', 'koffi', 'index.cjs'),
    join(exeDir, 'resources', 'app.asar.unpacked', 'node_modules', 'koffi', 'index.js'),
  ];
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', 'koffi', 'index.cjs'));
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', 'koffi', 'index.js'));
  }
  try {
    candidates.push(requireFromHere.resolve('koffi'));
  } catch {
    /* not a dependency of this package */
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const koffi = requireFromHere(candidate);
      const user32 = koffi.load('user32.dll');
      const SetProcessDPIAware = user32.func('bool SetProcessDPIAware()');
      try {
        SetProcessDPIAware();
      } catch {
        /* already aware */
      }
      const suffix = Math.random().toString(36).slice(2, 8);
      const pointName = 'DcwPoint' + suffix;
      const rectName = 'DcwRect' + suffix;
      const monitorName = 'DcwMonitorInfo' + suffix;
      const POINT = koffi.struct(pointName, { x: 'long', y: 'long' });
      const RECT = koffi.struct(rectName, {
        left: 'long',
        top: 'long',
        right: 'long',
        bottom: 'long',
      });
      const MONITORINFO = koffi.struct(monitorName, {
        cbSize: 'uint',
        rcMonitor: RECT,
        rcWork: RECT,
        dwFlags: 'uint',
      });
      return {
        POINT,
        RECT,
        MONITORINFO,
        GetCursorPos: user32.func(`bool GetCursorPos(_Out_ ${pointName} *pt)`),
        GetWindowRect: user32.func(`bool GetWindowRect(void *hwnd, _Out_ ${rectName} *rect)`),
        SetWindowPos: user32.func(
          'bool SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint flags)',
        ),
        GetAsyncKeyState: user32.func('short GetAsyncKeyState(int key)'),
        GetDpiForWindow: user32.func('uint GetDpiForWindow(void *hwnd)'),
        GetWindowLongW: user32.func('int GetWindowLongW(void *hwnd, int index)'),
        SetWindowLongW: user32.func('int SetWindowLongW(void *hwnd, int index, int value)'),
        IsZoomed: user32.func('bool IsZoomed(void *hwnd)'),
        ShowWindow: user32.func('bool ShowWindow(void *hwnd, int cmd)'),
        MonitorFromWindow: user32.func('void *MonitorFromWindow(void *hwnd, uint flags)'),
        GetMonitorInfoW: user32.func(
          `bool GetMonitorInfoW(void *monitor, _Inout_ ${monitorName} *info)`,
        ),
      };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Host half: owns the small-window geometry, animation, pin state and drag loop. */
export const inject = ['webServer'];

export function apply(ctx) {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, 'window.ps1');
  const stateDir = join(process.env.LOCALAPPDATA ?? here, 'dsh-compact-window');
  const stateFile = join(stateDir, 'state.json');
  const positionFile = join(stateDir, 'position.json');
  const prefsFile = join(stateDir, 'prefs.json');

  const win32 = loadWin32();
  // Every window operation here is Win32. Off Windows the route answers
  // `supported: false` instead of spawning a helper that could not work.
  const supported = process.platform === 'win32';
  let lastHwnd = 0;
  let lastMode = 'normal';
  let dragTimer = null;
  let dragHwnd = 0;
  let dragLogicalHeight = 0;
  let settleTimer = null;
  let animTimer = null;
  let discovery = null;

  /* ---------------- persistence ---------------- */
  const readState = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const writeState = (value) => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(stateFile, JSON.stringify(value));
    } catch {
      /* best effort */
    }
  };
  const deleteState = () => {
    try {
      if (existsSync(stateFile)) unlinkSync(stateFile);
    } catch {
      /* best effort */
    }
  };
  const readPrefs = () => {
    try {
      const value = JSON.parse(readFileSync(prefsFile, 'utf8'));
      return { pinned: value.pinned !== false };
    } catch {
      return { pinned: true };
    }
  };
  const writePrefs = (value) => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(prefsFile, JSON.stringify(value));
    } catch {
      /* best effort */
    }
  };
  const readPosition = () => {
    try {
      const value = JSON.parse(readFileSync(positionFile, 'utf8'));
      if (typeof value.x === 'number' && typeof value.y === 'number') return value;
    } catch {
      /* no remembered position */
    }
    return null;
  };
  const savePosition = (hwnd) => {
    if (!win32) return;
    try {
      const rect = {};
      if (!win32.GetWindowRect(hwnd, rect)) return;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(positionFile, JSON.stringify({ x: rect.left, y: rect.top }));
    } catch {
      /* best effort */
    }
  };

  /* ---------------- geometry helpers ---------------- */
  const workArea = (hwnd) => {
    const monitor = win32.MonitorFromWindow(hwnd, 2);
    const info = {
      cbSize: 40,
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
    };
    win32.GetMonitorInfoW(monitor, info);
    return info.rcWork && info.rcWork.right > info.rcWork.left
      ? info.rcWork
      : { left: 0, top: 0, right: 1920, bottom: 1080 };
  };
  const currentScale = (hwnd) => {
    const dpi = win32.GetDpiForWindow(hwnd);
    return dpi > 0 ? dpi / 96 : 1;
  };
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /* ---------------- animation ---------------- */
  const cancelAnimation = () => {
    if (animTimer !== null) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  /**
   * Ease the window between two rects on the Host clock (stable 60fps) with an
   * easeOutQuint curve: immediate departure, long soft settle, no overshoot —
   * the macOS window feel rather than an iOS bounce.
   */
  const animateTo = (hwnd, target, onDone) => {
    if (!win32) {
      if (onDone) onDone();
      return;
    }
    cancelAnimation();
    const from = {};
    if (!win32.GetWindowRect(hwnd, from)) {
      if (onDone) onDone();
      return;
    }
    const x0 = from.left;
    const y0 = from.top;
    const w0 = from.right - from.left;
    const h0 = from.bottom - from.top;
    if (
      Math.abs(target.x - x0) < 1 &&
      Math.abs(target.y - y0) < 1 &&
      Math.abs(target.w - w0) < 1 &&
      Math.abs(target.h - h0) < 1
    ) {
      if (onDone) onDone();
      return;
    }
    const started = Date.now();
    animTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / ANIMATION_MS);
      const e = 1 - Math.pow(1 - t, 5);
      const x = Math.round(x0 + (target.x - x0) * e);
      const y = Math.round(y0 + (target.y - y0) * e);
      const w = Math.round(w0 + (target.w - w0) * e);
      const h = Math.round(h0 + (target.h - h0) * e);
      win32.SetWindowPos(
        hwnd,
        null,
        x,
        y,
        w,
        h,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING,
      );
      if (t >= 1) {
        clearInterval(animTimer);
        animTimer = null;
        if (onDone) onDone();
      }
    }, 16);
  };

  /* ---------------- window state machine (native) ---------------- */
  const jsStatus = () => {
    const state = readState();
    const mode = state && state.mode === 'compact' ? 'compact' : 'normal';
    let pinned = false;
    if (lastHwnd && win32) {
      const ex = win32.GetWindowLongW(lastHwnd, GWL_EXSTYLE);
      pinned = (ex & WS_EX_TOPMOST) !== 0;
    }
    return { ok: true, mode, pinned, hwnd: lastHwnd || undefined, available: lastHwnd !== 0 };
  };

  const jsEnter = async (hwnd) => {
    const existing = readState();
    if (existing && existing.mode === 'compact') {
      return {
        ok: true,
        mode: 'compact',
        pinned: !!existing.pinned,
        hwnd,
        available: true,
      };
    }
    const wasZoomed = win32.IsZoomed(hwnd);
    if (wasZoomed) {
      win32.ShowWindow(hwnd, SW_RESTORE);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const rect = {};
    if (!win32.GetWindowRect(hwnd, rect)) throw new Error('window rect unavailable');
    const style = win32.GetWindowLongW(hwnd, GWL_STYLE);
    const exstyle = win32.GetWindowLongW(hwnd, GWL_EXSTYLE);
    const scale = currentScale(hwnd);
    const work = workArea(hwnd);
    const targetW = Math.round(COMPACT_WIDTH * scale);
    const targetH = Math.min(rect.bottom - rect.top, work.bottom - work.top);
    const margin = Math.round(16 * scale);
    const remembered = readPosition();
    let x;
    let y;
    if (remembered) {
      x = clamp(remembered.x, work.left + margin, work.right - targetW - margin);
      y = clamp(remembered.y, work.top + margin, work.bottom - targetH - margin);
    } else {
      x = work.right - targetW - margin;
      y = clamp(rect.top, work.top + margin, work.bottom - targetH - margin);
    }
    const pinned = readPrefs().pinned;
    writeState({
      mode: 'compact',
      hwnd,
      x: rect.left,
      y: rect.top,
      w: rect.right - rect.left,
      h: rect.bottom - rect.top,
      style,
      exstyle,
      targetW,
      targetH,
      wasZoomed,
      pinned,
    });
    win32.SetWindowLongW(hwnd, GWL_STYLE, style & ~WS_THICKFRAME);
    win32.SetWindowLongW(
      hwnd,
      GWL_EXSTYLE,
      (exstyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW,
    );
    win32.SetWindowPos(
      hwnd,
      pinned ? HWND_TOPMOST : HWND_NOTOPMOST,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );
    return {
      ok: true,
      mode: 'compact',
      pinned,
      hwnd,
      available: true,
      target: { x, y, w: targetW, h: targetH },
    };
  };

  const jsExit = (hwnd) => {
    const state = readState();
    if (!state || state.mode !== 'compact') {
      return { ok: true, mode: 'normal', pinned: false, hwnd, available: true };
    }
    const style = win32.GetWindowLongW(hwnd, GWL_STYLE);
    win32.SetWindowLongW(hwnd, GWL_STYLE, style | WS_THICKFRAME);
    win32.SetWindowLongW(hwnd, GWL_EXSTYLE, state.exstyle);
    win32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    deleteState();
    return {
      ok: true,
      mode: 'normal',
      pinned: false,
      hwnd,
      available: true,
      target: { x: state.x, y: state.y, w: state.w, h: state.h },
      wasZoomed: !!state.wasZoomed,
    };
  };

  const jsPin = (hwnd, pinned) => {
    win32.SetWindowPos(
      hwnd,
      pinned ? HWND_TOPMOST : HWND_NOTOPMOST,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );
    writePrefs({ pinned });
    const state = readState();
    if (state && state.mode === 'compact') {
      state.pinned = pinned;
      writeState(state);
    }
    return {
      ok: true,
      pinned,
      mode: state && state.mode === 'compact' ? 'compact' : 'normal',
      hwnd,
      available: true,
    };
  };

  const jsCleanup = () => {
    const state = readState();
    if (!state || state.mode !== 'compact' || !lastHwnd || !win32) return;
    const rect = {};
    if (!win32.GetWindowRect(lastHwnd, rect)) return;
    if (rect.right - rect.left > (state.targetW || 0) + 24) deleteState();
  };

  const jsRestore = () => {
    if (!win32 || !lastHwnd) return;
    const state = readState();
    if (!state || state.mode !== 'compact') return;
    const style = win32.GetWindowLongW(lastHwnd, GWL_STYLE);
    win32.SetWindowLongW(lastHwnd, GWL_STYLE, style | WS_THICKFRAME);
    win32.SetWindowLongW(lastHwnd, GWL_EXSTYLE, state.exstyle);
    win32.SetWindowPos(
      lastHwnd,
      HWND_NOTOPMOST,
      state.x,
      state.y,
      state.w,
      state.h,
      SWP_NOACTIVATE | SWP_NOSENDCHANGING,
    );
    deleteState();
  };

  /* ---------------- drag ---------------- */
  const applyGeometry = (hwnd, logicalHeight) => {
    if (!win32) return;
    const scale = currentScale(hwnd);
    const work = workArea(hwnd);
    const rect = {};
    if (!win32.GetWindowRect(hwnd, rect)) return;
    const targetW = Math.round(COMPACT_WIDTH * scale);
    const targetH = Math.min(Math.round(logicalHeight * scale), work.bottom - work.top);
    win32.SetWindowPos(
      hwnd,
      null,
      rect.left,
      rect.top,
      targetW,
      targetH,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING,
    );
  };

  const cancelSettle = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const stopDrag = (settle = true) => {
    if (dragTimer !== null) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    const hwnd = dragHwnd;
    const logicalHeight = dragLogicalHeight;
    dragHwnd = 0;
    dragLogicalHeight = 0;
    if (!hwnd) return;

    cancelSettle();
    if (!settle) {
      savePosition(hwnd);
      return;
    }
    // Electron handles WM_DPICHANGED asynchronously and may re-apply its minimum
    // width afterwards, so keep correcting for a moment instead of trusting one frame.
    let remaining = 8;
    const step = () => {
      settleTimer = null;
      if (!win32) return;
      applyGeometry(hwnd, logicalHeight);
      remaining -= 1;
      if (remaining > 0) settleTimer = setTimeout(step, 120);
      else savePosition(hwnd);
    };
    settleTimer = setTimeout(step, 60);
  };

  const startDrag = (hwnd) => {
    if (!win32 || dragTimer !== null) return;
    cancelAnimation();
    const point = {};
    if (!win32.GetCursorPos(point)) return;
    const rect = {};
    if (!win32.GetWindowRect(hwnd, rect)) return;

    const grabX = point.x - rect.left;
    const grabY = point.y - rect.top;
    const logicalHeight = (rect.bottom - rect.top) / currentScale(hwnd);

    cancelSettle();
    dragHwnd = hwnd;
    dragLogicalHeight = logicalHeight;

    dragTimer = setInterval(() => {
      if ((win32.GetAsyncKeyState(VK_LBUTTON) & 0x8000) === 0) {
        stopDrag();
        return;
      }
      const cursor = {};
      if (!win32.GetCursorPos(cursor)) return;

      const scale = currentScale(hwnd);
      const work = workArea(hwnd);
      const targetW = Math.round(COMPACT_WIDTH * scale);
      const targetH = Math.min(Math.round(logicalHeight * scale), work.bottom - work.top);

      const x = Math.min(Math.max(cursor.x - grabX, work.left - targetW + 120), work.right - 120);
      const y = Math.min(Math.max(cursor.y - grabY, work.top), work.bottom - 40);

      const current = {};
      if (!win32.GetWindowRect(hwnd, current)) return;
      const sizeWrong =
        Math.abs(current.right - current.left - targetW) > 2 ||
        Math.abs(current.bottom - current.top - targetH) > 2;

      win32.SetWindowPos(
        hwnd,
        null,
        x,
        y,
        sizeWrong ? targetW : 0,
        sizeWrong ? targetH : 0,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING | (sizeWrong ? 0 : SWP_NOSIZE),
      );
    }, 16);
  };

  /* ---------------- PowerShell: discovery and fallback only ---------------- */
  const call = async (action, extra = {}) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ParentPid',
      String(process.ppid),
      '-Action',
      action,
      '-StateFile',
      stateFile,
    ];
    for (const [key, value] of Object.entries(extra)) args.push('-' + key, String(value));
    const { stdout } = await run('powershell.exe', args, {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout ?? '').trim();
    if (!text) throw new Error('window helper returned no output');
    return JSON.parse(text);
  };

  const discover = () => {
    if (!discovery) {
      discovery = call('status')
        .then((state) => {
          lastHwnd = Number(state.hwnd) || lastHwnd;
          lastMode = state.mode ?? lastMode;
          return state;
        })
        .catch(() => null);
    }
    return discovery;
  };

  const send = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ ...value, drag: Boolean(win32), supported }));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/compact-window',
        handler: async (req, res) => {
          try {
            if (!supported) {
              send(res, 200, {
                ok: false,
                error: 'compact window mode needs the DSH desktop app on Windows',
              });
              return;
            }
            if (req.method === 'GET') {
              if (!lastHwnd) await discover();
              send(res, 200, win32 && lastHwnd ? jsStatus() : await call('status'));
              return;
            }
            if (req.method !== 'POST') {
              send(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            const body = await readBody(req);
            const action = body && typeof body.action === 'string' ? body.action : '';

            if (action === 'dragStart') {
              if (!lastHwnd) await discover();
              if (lastMode === 'compact' && lastHwnd) startDrag(lastHwnd);
              send(res, 200, { ok: true, mode: lastMode });
              return;
            }
            if (action === 'dragEnd') {
              stopDrag();
              send(res, 200, { ok: true, mode: lastMode });
              return;
            }
            if (action === 'pin') {
              const pinned = body.pinned === true;
              let state;
              if (win32 && lastHwnd) {
                state = jsPin(lastHwnd, pinned);
              } else {
                state = await call('setPin', { Pinned: pinned ? 1 : 0 });
                writePrefs({ pinned });
                lastHwnd = Number(state.hwnd) || lastHwnd;
              }
              lastMode = state.mode ?? lastMode;
              send(res, 200, { ...state, pinned });
              return;
            }
            if (!['enter', 'exit', 'toggle'].includes(action)) {
              send(res, 400, { ok: false, error: 'bad action' });
              return;
            }

            if (!lastHwnd) await discover();
            let state;
            if (win32 && lastHwnd) {
              const resolved =
                action === 'toggle'
                  ? (readState()?.mode === 'compact' ? 'exit' : 'enter')
                  : action;
              state = resolved === 'enter' ? await jsEnter(lastHwnd) : jsExit(lastHwnd);
            } else {
              const extra = { DeferResize: 1 };
              if (action === 'enter' || action === 'toggle') {
                extra.Pinned = readPrefs().pinned ? 1 : 0;
                const remembered = readPosition();
                if (remembered) {
                  extra.PosX = remembered.x;
                  extra.PosY = remembered.y;
                }
              }
              state = await call(action, extra);
              lastHwnd = Number(state.hwnd) || lastHwnd;
            }

            lastMode = state.mode ?? lastMode;
            if (lastMode !== 'compact') stopDrag(false);
            if (state.target && lastHwnd) {
              cancelSettle();
              const target = state.target;
              const wasZoomed = state.wasZoomed === true;
              state.animationMs = ANIMATION_MS;
              animateTo(lastHwnd, target, () => {
                if (wasZoomed && win32) win32.ShowWindow(lastHwnd, SW_MAXIMIZE);
              });
            }
            send(res, 200, state);
          } catch (error) {
            send(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    'compact-window:route',
  );

  // One slow PowerShell call at startup discovers the window handle; everything
  // afterwards runs natively in this process.
  if (supported) {
    discover()
      .then(() => {
        jsCleanup();
      })
      .catch(() => {});
  }

  ctx.effect(
    () => () => {
      cancelAnimation();
      stopDrag(false);
      if (win32) jsRestore();
      else if (supported) call('exit').catch(() => {});
    },
    'compact-window:restore',
  );
}
