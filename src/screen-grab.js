'use strict';

/**
 * 截屏小助手：常驻一个 PowerShell 进程，用 GDI（BitBlt / Graphics.CopyFromScreen）按需截一小块屏幕。
 *
 * 为什么不用 Chromium 自带的截屏（getDisplayMedia / desktopCapturer）：
 * 在用户的机器上两种都直接报 NotReadableError（系统拒绝启动 GPU 截屏 —— 混合显卡笔记本、
 * 以管理员身份运行时很常见）。GDI 复制不走显卡复制那条路，几乎在任何 Windows 上都能用，
 * 而且只截小地图周围几百像素的一块，实测 500×500 约 18ms。
 * 打了「不参与截屏」标记（WDA_EXCLUDEFROMCAPTURE）的窗口 GDI 同样拍不到，本程序的浮窗不会混进来。
 *
 * 协议：
 *   主进程 → stdin：一行 "x y w h"（屏幕物理像素）
 *   stdout ← 帧：20 字节头（magic 'GIFA'、w、h、ok、stride，均为 int32 小端）+ stride×h 字节 BGRA
 */

const { spawn } = require('node:child_process');

const MAGIC = 0x47494641;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class GifaDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
$aware = $false
try { $aware = [GifaDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { }
if (-not $aware) { [void][GifaDpi]::SetProcessDPIAware() }
Add-Type -AssemblyName System.Drawing
$out = [Console]::OpenStandardOutput()
$fmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Trim().Split(' ')
  if ($p.Length -lt 4) { continue }
  $x = [int]$p[0]; $y = [int]$p[1]; $w = [Math]::Max(1, [int]$p[2]); $h = [Math]::Max(1, [int]$p[3])
  $ok = 1
  $bmp = New-Object System.Drawing.Bitmap($w, $h, $fmt)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h))) } catch { $ok = 0 }
  $g.Dispose()
  $bd = $bmp.LockBits((New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $fmt)
  $len = $bd.Stride * $h
  $bytes = New-Object byte[] $len
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $len)
  $stride = $bd.Stride
  $bmp.UnlockBits($bd); $bmp.Dispose()
  $hdr = New-Object byte[] 20
  [BitConverter]::GetBytes([int]0x47494641).CopyTo($hdr, 0)
  [BitConverter]::GetBytes([int]$w).CopyTo($hdr, 4)
  [BitConverter]::GetBytes([int]$h).CopyTo($hdr, 8)
  [BitConverter]::GetBytes([int]$ok).CopyTo($hdr, 12)
  [BitConverter]::GetBytes([int]$stride).CopyTo($hdr, 16)
  $out.Write($hdr, 0, 20); $out.Write($bytes, 0, $len); $out.Flush()
}
`;

function createScreenGrabber() {
  let proc = null;
  let buf = Buffer.alloc(0);
  let pending = null;
  let stderr = '';
  let lastError = '';

  function fail(msg) {
    lastError = msg;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(msg));
      pending = null;
    }
  }

  function parse() {
    while (buf.length >= 20) {
      if (buf.readInt32LE(0) !== MAGIC) {
        // 不该发生：输出被别的东西污染了。丢掉缓冲，等下一帧
        buf = Buffer.alloc(0);
        fail('capture stream out of sync');
        return;
      }
      const w = buf.readInt32LE(4);
      const h = buf.readInt32LE(8);
      const ok = buf.readInt32LE(12);
      const stride = buf.readInt32LE(16);
      const need = 20 + stride * h;
      if (buf.length < need) return;
      const data = Buffer.from(buf.subarray(20, need));
      buf = buf.subarray(need);
      if (pending) {
        clearTimeout(pending.timer);
        const p = pending;
        pending = null;
        if (ok) p.resolve({ w, h, stride, data });
        else p.reject(new Error('CopyFromScreen failed (locked screen / UAC prompt?)'));
      }
    }
  }

  function start() {
    if (proc) return;
    stderr = '';
    buf = Buffer.alloc(0);
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      parse();
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on('error', (err) => fail(`helper: ${err.message}`));
    proc.on('exit', (code) => {
      proc = null;
      fail(`helper exited (${code}) ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim());
    });
  }

  /** 截一块屏幕（物理像素）。上一张还没回来时直接拒绝，调用方丢掉这一帧即可 */
  function grab(x, y, w, h) {
    if (!proc) start();
    if (pending) return Promise.reject(new Error('busy'));
    return new Promise((resolve, reject) => {
      // 第一次要等 PowerShell 启动、编译 Add-Type，给足时间
      const timer = setTimeout(() => fail('capture timeout'), lastError || !proc ? 8000 : 5000);
      pending = { resolve, reject, timer };
      try {
        proc.stdin.write(`${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}\n`);
      } catch (err) {
        fail(`helper stdin: ${err.message}`);
      }
    });
  }

  function stop() {
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      /* 已退出 */
    }
    proc = null;
  }

  return {
    start,
    grab,
    stop,
    get running() {
      return !!proc;
    },
    get busy() {
      return !!pending;
    },
    get lastError() {
      return lastError;
    }
  };
}

module.exports = { createScreenGrabber };
