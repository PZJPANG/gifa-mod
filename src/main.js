'use strict';

/**
 * 原神跟跑助手 —— 主进程
 * 职责：无边框置顶窗口、全局快捷键、B 站视频解析、设置持久化
 */

const { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, powerSaveBlocker, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const hookHotkeys = require('./hook-hotkeys');
const { mergeHotkeys, prepareHotkeyUpdate } = require('./hotkey-config');
const {
  createSubtitleSource,
  tracksFromPlayerData,
  pickTrack,
  DEFAULT_PAUSE_KEYWORDS,
  compileKeywords,
  matchKeyword,
  parseKeywordText,
  crossedPauseCue
} = require('./subtitle-source');
const { createScreenGrabber } = require('./screen-grab');
const { createTurnDetector } = require('./turn-detect');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 允许无用户手势自动播放（浮窗场景必须有）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 关掉 Chromium 的「后台进程进效率模式」：Windows 11 会在进程所有窗口都最小化时
// 把它判成后台、套上 EcoQoS（低优先级 + 省电调度）。低级钩子跑在独立线程里，
// 一旦被这样降速，按键回调就会超时、甚至被系统悄悄把钩子摘掉 ——
// 表现正是「启动器在前台时热键好用，一最小化就全废，切回来也回不来」。
app.commandLine.appendSwitch('disable-features', 'UseEcoQoSForBackgroundProcess');

/**
 * 是否以管理员（高完整性级别）身份运行。
 *
 * 这条决定了热键在游戏里能不能用：原神这类带反作弊的游戏一律以管理员启动，
 * 而 Windows 的 UIPI 规定 —— **非提权进程的低级键盘/鼠标钩子，收不到提权窗口在前台时的按键**。
 * 于是现象就是「启动器在前台时热键好用，一切进游戏里就全废」，与代码无关。
 * 这不是我们能绕的系统约束，只能提权运行（打包版清单里已要求管理员）。
 */
let cachedElevated = null;
// 提权重启时带上的标记，用来区分「本来就没提权」和「用户刚拒绝过 UAC」
const ELEVATE_FLAG = '--elevated';
function isElevated() {
  if (cachedElevated !== null) return cachedElevated;
  try {
    // 用 PowerShell 而不是 `whoami /groups`：在 Git Bash / MSYS 里启动时，
    // MSYS 会把 `/groups` 当 POSIX 路径转换成 `C:/Program Files/Git/groups`，
    // whoami 直接报「extra operand」→ 提权状态被误判成 false，白弹一次 UAC。
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const out = execFileSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    // S-1-16-12288 = High Mandatory Level（管理员）；中完整性是 S-1-16-8192
    cachedElevated = out.trim().toLowerCase() === 'true';
  } catch {
    cachedElevated = false;
  }
  return cachedElevated;
}

/* ------------------------------------------------- 按需提权重启（UAC） */

/**
 * 以管理员身份重新启动本程序（兜底路径）。
 *
 * 现在打包版是「双击即提权」，配置在 package.json：
 *   win.requestedExecutionLevel = "requireAdministrator"  → 主 exe 清单
 *   portable.requestExecutionLevel = "admin"              → NSIS 自解压壳清单
 * 两层都提权，双击时 Windows 只弹一次 UAC、壳只解压一次，不必进来再点重启。
 *
 * 历史坑（dist-release3）：只给内层 app.exe 加 requireAdministrator、壳仍是 asInvoker，
 * 壳用 ExecWait 启动 app.exe 时 Windows 返回 ERROR_ELEVATION_REQUIRED(740)，
 * 双击毫无反应、进程都不出现。关键是**壳和主程序必须同时提权**。
 *
 * 运行时重启只留给：开发版（electron.exe 无清单）、zip 解压直跑、UAC 被取消后
 * 仍想用普通权限，以及任何清单没生效的场景。提权是为低级键盘钩子服务的：
 * 不提权的话，UIPI 会挡住提权窗口（原神）在前台时的按键。
 */
function relaunchElevated() {
  return new Promise((resolve) => {
    // portable 版必须用**原始 exe**：process.execPath 指向 %TEMP% 里的解压副本，
    // 从那里重启等于从一个随时会被清掉的目录里启动。
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const argv = process.argv
      .slice(1)
      .filter((a) => !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') && a !== ELEVATE_FLAG);
    // 打上标记：万一下次判断提权状态出错，也不会陷入「无限弹 UAC」
    argv.unshift(ELEVATE_FLAG);

    // PowerShell 单引号字符串里，单引号本身写成两个
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = argv.length ? ` -ArgumentList @(${argv.map(q).join(',')})` : '';
    const script =
      `Start-Process -FilePath ${q(exePath)}${argList}` +
      ` -WorkingDirectory ${q(process.cwd())} -Verb RunAs -ErrorAction Stop`;

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      // 退出码 0 = 提权后的新进程已经创建；非 0 基本都是用户在 UAC 上点了「否」
      resolve(code === 0 ? { ok: true } : { ok: false, reason: 'uac-cancelled' });
    });
  });
}

/* ------------------------------- 数据目录：绿色版 / 安装版 [DATA-DIR-START] */

/**
 * 决定 userData 落在哪 —— 两种发行形态必须分流，否则安装版必坏。
 *
 *  绿色版（zip / portable 单 exe）：exe 同级 data\，整夹拷走设置与 ROI 标定一起走。
 *  安装版（NSIS，装到 Program Files）：%APPDATA%\原神跟跑助手\，
 *    因为 Program Files 对普通用户只读，写 settings.json 会直接抛 EPERM。
 *
 * 判定**只看 installed.flag**（由 build/installer.nsh 安装时写在 exe 同级），
 * 不猜安装路径：有人把绿色版放进 Program Files，也有人把安装版装在 D 盘可写目录，
 * 路径都不可靠。zip 里放的是 portable.flag，安装版里没有它，两者不会混淆。
 *
 * 开发时（npm start）一律用系统默认 %APPDATA%，不动用户已有设置和登录态。
 *
 * 两个老坑：
 * 1. portable 单 exe 先解压到 %TEMP% 再运行，process.execPath 指向临时副本，
 *    真实位置 electron-builder 写在 PORTABLE_EXECUTABLE_DIR 里，必须优先用它。
 * 2. 程序目录不可写时退回 APPDATA，否则启动阶段就会因为建不了 settings.json 报错。
 */
const DATA_DIR_NAME = 'data';
const INSTALLED_FLAG = 'installed.flag';
const PORTABLE_FLAG = 'portable.flag';
const MIGRATE_FROM_FILE = 'migrate-from.txt';
const MIGRATED_FLAG = '.migrated';
// settings.json 内含 ROI 标定、窗口位置、观看记录；两张 png 是识别调试截图。
// Chromium 缓存 / GPUCache / 日志一律不搬，避免把几十 MB 垃圾和隐私带进新目录。
const MIGRATE_FILES = ['settings.json', 'bearing-dump.png', 'bearing-frame.png'];
const MIGRATE_LOGIN_DIR = 'Partitions';
const MIGRATE_LOGIN_FILES = ['Local State'];

function programDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function hasProgramFlag(name) {
  try {
    return fs.existsSync(path.join(programDir(), name));
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 只复制白名单文件，且绝不覆盖目标里已存在的内容 */
function copyFileIfAbsent(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn(`[data] 复制 ${path.basename(src)} 失败：${err.code || err.message}`);
    return false;
  }
}

function copyTreeIfAbsent(srcDir, dstDir) {
  if (!fs.existsSync(srcDir) || fs.existsSync(dstDir)) return;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const from = path.join(srcDir, ent.name);
      const to = path.join(dstDir, ent.name);
      if (ent.isDirectory()) copyTreeIfAbsent(from, to);
      else if (ent.isFile()) copyFileIfAbsent(from, to);
    }
  } catch (err) {
    console.warn(`[data] 复制目录 ${srcDir} 失败：${err.code || err.message}`);
  }
}

/**
 * 旧绿色版 data\ 的可能位置，按优先级：
 *  1. 安装页「迁移旧数据」填的目录 → 写在 exe 同级 migrate-from.txt 第一行
 *  2. GRB_MIGRATE_FROM 环境变量（手动 / CI 用）
 *  3. exe 同级 data\（把安装版覆盖装到原绿色版目录里的场景）
 * 允许填绿色版根目录或它里面的 data 目录，自动识别。
 */
function legacyDataCandidates(target) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    let dir = path.resolve(String(value).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(path.join(dir, 'settings.json')) &&
        fs.existsSync(path.join(dir, DATA_DIR_NAME, 'settings.json'))) {
      dir = path.join(dir, DATA_DIR_NAME);
    }
    if (dir !== path.resolve(target) && !out.includes(dir)) out.push(dir);
  };
  const lines = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE)).split(/\r?\n/);
  add(lines[0]);
  add(process.env.GRB_MIGRATE_FROM);
  add(path.join(programDir(), DATA_DIR_NAME));
  return out;
}

function migrationIncludeLogin() {
  const text = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE));
  return /includeLogin\s*=\s*1/.test(text) || process.env.GRB_MIGRATE_LOGIN === '1';
}

/**
 * 安装版首次启动时，把旧绿色版的设置 / ROI 标定搬进 %APPDATA%。
 *
 * 登录态（Partitions + Local State）**默认不搬**：过去「打包前顺手把 Cookie 库
 * 拷进 data\」的教训是，那份带凭证的目录会被整包发出去，等于送账号。
 * 这里方向相反 —— 只在本机、从用户明确指定的旧目录搬进本机 APPDATA，
 * 不进任何发布产物，所以做成安装页上的可选项（includeLogin=1）是安全的。
 * 复制而非移动，旧绿色版仍可照常用；.migrated 标记保证只跑一次。
 */
function migrateLegacyData(target) {
  const marker = path.join(target, MIGRATED_FLAG);
  if (fs.existsSync(marker) || fs.existsSync(path.join(target, 'settings.json'))) {
    return { ok: false, reason: 'already-initialized' };
  }
  const source = legacyDataCandidates(target).find(
    (dir) => fs.existsSync(path.join(dir, 'settings.json'))
  );
  if (!source) return { ok: false, reason: 'no-legacy-data' };

  const withLogin = migrationIncludeLogin();
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    console.warn(`[data] 创建 ${target} 失败：${err.code || err.message}`);
    return { ok: false, reason: 'target-not-writable' };
  }

  let copied = 0;
  for (const name of MIGRATE_FILES) {
    if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
  }
  if (withLogin) {
    for (const name of MIGRATE_LOGIN_FILES) {
      if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
    }
    copyTreeIfAbsent(path.join(source, MIGRATE_LOGIN_DIR), path.join(target, MIGRATE_LOGIN_DIR));
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ from: source, at: new Date().toISOString(), withLogin }, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[data] 写迁移标记失败：${err.code || err.message}`);
  }
  console.log(`[data] 已从 ${source} 迁移 ${copied} 项${withLogin ? '（含登录态）' : '（不含登录态）'}`);
  return { ok: true, from: source, copied, withLogin };
}

let installMode = 'dev'; // dev | installed | portable | fallback
function resolveUserDataDir() {
  const fallback = app.getPath('userData');
  if (!app.isPackaged) {
    installMode = 'dev';
    return fallback;
  }

  if (hasProgramFlag(INSTALLED_FLAG)) {
    installMode = 'installed';
    try {
      migrateLegacyData(fallback);
    } catch (err) {
      console.warn(`[data] 旧数据迁移异常，继续用 ${fallback}：${err.message}`);
    }
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }

  const dir = path.join(programDir(), DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 探写权限：只判断 exists 不够，目录可能存在但没有写权限
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    installMode = 'portable';
    return dir;
  } catch (err) {
    console.warn(`[data] 程序目录不可写（${err.code || err.message}），回退到 ${fallback}`);
    installMode = 'fallback';
    return fallback;
  }
}

const USER_DATA_DIR = resolveUserDataDir();
app.setPath('userData', USER_DATA_DIR);
// 缓存类目录一并挪过去，否则 C 盘会多出一份 Chromium 缓存
app.setPath('sessionData', USER_DATA_DIR);
/* [DATA-DIR-END] ---------------------------------------------------------- */


// 支持 `npm start -- --open BV1xx411c7mD`：从命令行/快捷方式直接带视频启动
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : '';
  return v && !v.startsWith('--') ? v : '';
}
const OPEN_ARG = argValue('--open');

// 播放器与登录窗口共用同一个持久化分区，登录一次全局生效
const BILI_PARTITION = 'persist:bili';

function biliSession() {
  return session.fromPartition(BILI_PARTITION);
}

/** 用该分区的 Cookie 发请求，避开 B 站风控，并且能读到登录态 */
function biliFetch(url, extraHeaders) {
  return biliSession().fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      ...(extraHeaders || {})
    }
  });
}

const DEFAULT_HOTKEYS = {  togglePlay: 'Alt+Space',
  seekBack: 'Alt+Left',
  seekFwd: 'Alt+Right',
  prevPart: 'Alt+Up',
  nextPart: 'Alt+Down',
  toggleVisible: 'Alt+H',
  togglePass: 'Alt+L',
  toggleOpacity: 'Alt+O',
  toggleImmersion: 'Alt+I',
  cycleSpeed: 'Alt+S',
  holdSpeed: 'F8',
  toggleSubtitle: 'Alt+C',
  moveSubtitle: 'Alt+V',
  toggleDanmaku: 'Alt+D'
};

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const HOLD_PLAYBACK_RATES = [1.25, 1.5, 2, 2.5, 3];

const HOTKEY_META = [
  { key: 'togglePlay', label: '播放 / 暂停' },
  { key: 'seekBack', label: '后退 5 秒' },
  { key: 'seekFwd', label: '前进 5 秒' },
  { key: 'prevPart', label: '上一分 P' },
  { key: 'nextPart', label: '下一分 P' },
  { key: 'toggleVisible', label: '隐藏 / 显示浮窗' },
  { key: 'togglePass', label: '鼠标穿透 开 / 关' },
  { key: 'toggleOpacity', label: '半透明 开 / 关' },
  { key: 'toggleImmersion', label: '纯视频沉浸 开 / 关' },
  { key: 'cycleSpeed', label: '循环倍速 1 / 1.25 / 1.5 / 2' },
  { key: 'holdSpeed', label: '长按临时加速（松开恢复）', hold: true },
  { key: 'toggleSubtitle', label: '游戏内字幕 显示 / 隐藏' },
  { key: 'moveSubtitle', label: '字幕 调整位置 / 锁定' },
  { key: 'toggleDanmaku', label: '全屏弹幕 显示 / 隐藏' }
];

/**
 * 出厂预置的识别区域 —— 只用来定「第一次框选时金色圆环的起始位置」，不写进 rois。
 *
 * 这里踩过一个坑：早先把两个猜的坐标直接塞进 DEFAULT_SETTINGS.bearing.rois，
 * 而保存逻辑是「位置接近就替换、否则追加」。用户框一次，猜错的那条留在列表里，
 * 面板上就显示「已标定 2 处」，其中一处压根没对准小地图 —— 这就是
 * 「框选一次出两次标定」的根因。现在出厂列表为空，下面这个值只影响圆环初值。
 *
 * 数值来自实测对准的原生迷你地图 / 博主放大贴片布局。
 */
const SEED_ROI = { cx: 0.1434, cy: 0.2481, r: 0.1542 };

/** 0.2.3 及更早版本写进出厂列表的猜测值，装载设置时精确剔除（容差 1e-4，不会误伤真实标定） */
const LEGACY_SEED_ROIS = [
  { cx: 0.0875, cy: 0.122, r: 0.046 },
  { cx: 0.148, cy: 0.222, r: 0.163 }
];

/** 剔除历史遗留的出厂猜测值；顺手丢掉结构不合法的条目 */
function dropLegacySeeds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r) =>
      r &&
      Number.isFinite(r.cx) &&
      Number.isFinite(r.cy) &&
      Number.isFinite(r.r) &&
      !LEGACY_SEED_ROIS.some(
        (s) =>
          Math.abs(s.cx - r.cx) < 1e-4 &&
          Math.abs(s.cy - r.cy) < 1e-4 &&
          Math.abs(s.r - r.r) < 1e-4
      )
  );
}

const DEFAULT_SETTINGS = {
  // 内容区 896×504 正好 16:9，加上标题栏 30 + 控制条 34 = 604
  bounds: { width: 896, height: 568, x: null, y: null, aspect: 2 },
  pinned: true,
  opacity: 1,
  clickThrough: false,
  mode: 'web',
  volume: 100,
  muted: false,
  playbackRate: 1,
  holdPlaybackRate: 2,
  hoverFadeEnabled: true,
  muxed: false,
  lastText: '',
  lastPart: 1,
  // 「上次看到」：光有 lastText/lastPart 不够 —— 用户记不住的是「哪个视频、第几 P」，
  // 长链接/BV 号看不出片名，所以额外存标题、视频 id、分 P 总数和最后观看时间。
  lastTitle: '',
  lastVideoId: '',
  lastPageCount: 0,
  lastWatchedAt: 0,
  // 下次启动直接把浮窗起来继续播，不用每次重粘链接
  resumeOnLaunch: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  bearing: {
    enabled: false,
    /**
     * 识别区域列表：{ cx, cy, r }，cx/cy 按画面宽高归一、r 按画面宽度归一。
     * 一个视频里布局会变（原生迷你地图 / 剪辑放大的地图贴片），所以要存多块。
     *
     * 出厂**必须为空**：预置猜测值会被算成「已经标定过」，用户框一次就变两处。
     * 圆环初值走 SEED_ROI，未标定时界面也会主动引导去框一次。
     */
    rois: [],
    // 用户是否在画面上真正框过一次；没框过就先引导标定，不拿默认值硬猜
    calibrated: false,
    // 按视频记住标定结果
    roiBy: {},
    // 叠加层：圆环半径（屏幕像素）与圆心屏幕坐标
    radius: 110,
    x: null,
    y: null,
    // 视频角色定位：把博主的小地图和你屏幕上的小地图比对，在你的小地图上画出博主的位置点
    locate: true,
    // 每个视频学到的缩放比例（博主小地图 / 你的小地图），下次打开直接用，不用再学
    locateScaleBy: {}
  },
  // 游戏内字幕：独立的透明置顶窗，位置 / 大小 / 字号都记住
  subtitle: {
    enabled: false,
    fontSize: 30,
    bgOpacity: 0.35,
    // 选定的字幕语言（lan，如 zh-CN / ai-zh）；空 = 自动挑
    lang: '',
    x: null,
    y: null,
    width: null,
    height: null
  },
  // 字幕里说到「过完剧情」之类的话，这句说完就自动暂停视频，等玩家自己把剧情过完
  autoPause: {
    enabled: true,
    keywords: DEFAULT_PAUSE_KEYWORDS.slice()
  },
  // 全屏弹幕：透明穿透层盖满主屏，跟着视频时间轴滚
  danmaku: {
    enabled: false,
    opacity: 0.85,
    fontSize: 25,
    duration: 8, // 一条滚动弹幕横穿屏幕的秒数，越小越快
    area: 0.5, // 只占屏幕上方这么大的比例，免得挡住游戏中间
    avoidMap: true // 小地图那一块不画弹幕（位置跟「方位标定」里摆好的红圈走）
  },
  // 转向提醒：博主左转 / 右转 / 掉头时，屏幕上弹一个大箭头（靠红箭头那一路行进方向判断）
  turn: {
    enabled: true,
    minTurn: 60, // 方向变化至少这么多度才算转弯
    x: null,
    y: null
  }
};

/**
 * 记住「上次看到」。换片和切 P 都走这里，字段一次写全。
 * 抽成纯函数是为了能离线回归（只就地改传入对象，不碰 fs / Electron）。
 */
/** 启动时是否自动把浮窗起来继续播（纯函数，便于离线回归） */
function shouldResumeOnLaunch(s, openArg) {
  if (openArg) return false; // --open 显式指定了视频，别抢
  return !!(s && s.resumeOnLaunch !== false && s.lastText);
}

function noteWatched(s, info) {
  if (!s) return s;
  const text = String(info.text || '').trim();
  if (text) s.lastText = text;
  const p = Number(info.p);
  if (Number.isFinite(p) && p > 0) s.lastPart = Math.floor(p);
  if (info.id) s.lastVideoId = String(info.id);
  if (info.title !== undefined) s.lastTitle = String(info.title || '');
  if (info.pageCount !== undefined) {
    const n = Number(info.pageCount);
    s.lastPageCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  s.lastWatchedAt = Date.now();
  return s;
}

/** 音量用 0..100 保存；静音独立保存，取消静音时仍能回到原来的音量。 */
function playbackSettings(s = {}) {
  const volume = Number.isFinite(s.volume) ? Math.min(100, Math.max(0, s.volume)) : 100;
  return {
    volume,
    muted: typeof s.muted === 'boolean' ? s.muted : volume === 0,
    playbackRate: Number.isFinite(s.playbackRate) ? Math.min(3, Math.max(0.25, s.playbackRate)) : 1
  };
}

function updatePlaybackSettings(s, patch = {}) {
  const next = playbackSettings(s);
  if (Number.isFinite(patch.volume)) {
    next.volume = Math.min(100, Math.max(0, patch.volume));
    // 启动器拖动音量时，正值取消静音；只切静音不会丢掉原来的音量。
    next.muted = next.volume === 0;
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  if (Number.isFinite(patch.playbackRate)) next.playbackRate = Math.min(3, Math.max(0.25, patch.playbackRate));
  const changed = Object.keys(next).some((key) => s[key] !== next[key]);
  Object.assign(s, next);
  return changed;
}

let settings = structuredClone(DEFAULT_SETTINGS);
let win = null;         // 跟跑浮窗（无边框置顶，只管播放）
let consoleWin = null;  // 启动器（所有设置都在这里）
let loginWin = null;
let playbackGuest = null;
let playbackToken = 0;
let playbackGate = 0;
let quittingFromConsole = false; // 关启动器 = 退出整个应用，防止 closed 事件重入
let failedHotkeys = [];
let saveTimer = null;
// 渲染层上报的输入状态：打字时不该触发单键热键，但「窗口在前台」不等于在打字
let typingInField = false;
let capturingHotkey = false;
let holdSpeedActive = false;
let immersion = false;
let hoverFaded = false;
let hoverTimer = null;
let hoverCandidate = false;
let hoverCandidateAt = 0;

/* ------------------------------------------------------------------ 设置 */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const rawBearing = raw.bearing || {};

    // 迁移：剔除 0.2.3 及更早版本写进出厂列表的猜测区域。
    // 那两条会被当成「已标定」，用户框一次就变成两处标定，先清干净再谈别的。
    const rois = dropLegacySeeds(rawBearing.rois);
    const roiBy = {};
    for (const [id, list] of Object.entries(rawBearing.roiBy || {})) {
      const kept = dropLegacySeeds(list);
      if (kept.length) roiBy[id] = kept;
    }

    settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      ...playbackSettings(raw),
      holdPlaybackRate: HOLD_PLAYBACK_RATES.includes(raw.holdPlaybackRate) ? raw.holdPlaybackRate : 2,
      hoverFadeEnabled: raw.hoverFadeEnabled !== false,
      bounds: { ...DEFAULT_SETTINGS.bounds, ...(raw.bounds || {}) },
      hotkeys: mergeHotkeys(DEFAULT_HOTKEYS, raw.hotkeys),
      bearing: {
        ...DEFAULT_SETTINGS.bearing,
        ...rawBearing,
        rois,
        roiBy,
        // 清完一条不剩，就别再标榜「已标定」，否则界面显示 0 处却不去引导框选
        calibrated: !!rawBearing.calibrated && rois.length > 0
      },
      subtitle: { ...DEFAULT_SETTINGS.subtitle, ...(raw.subtitle || {}) },
      autoPause: {
        enabled: !(raw.autoPause && raw.autoPause.enabled === false),
        keywords:
          raw.autoPause && Array.isArray(raw.autoPause.keywords)
            ? parseKeywordText(raw.autoPause.keywords.join(','))
            : DEFAULT_PAUSE_KEYWORDS.slice()
      },
      danmaku: { ...DEFAULT_SETTINGS.danmaku, ...(raw.danmaku || {}) },
      turn: { ...DEFAULT_SETTINGS.turn, ...(raw.turn || {}) }
    };
    // 已移除的 BetterGI 联动留下的旧设置，别再写回文件
    delete settings.bgi;
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
}

function flushSettings() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 写入失败', err);
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 250);
}

function isPlaybackGuest(sender) {
  return !!(win && !win.isDestroyed() && sender === playbackGuest &&
    sender.hostWebContents === win.webContents);
}

function isPlaybackMessage(event, message) {
  return isPlaybackGuest(event.sender) && event.senderFrame === event.sender.mainFrame &&
    message && message.token === playbackToken;
}

function playbackState() {
  return {
    ...playbackSettings(settings),
    holdActive: holdSpeedActive,
    temporaryPlaybackRate: holdSpeedActive ? settings.holdPlaybackRate : null
  };
}

function guestPlaybackSettings() {
  return {
    ...playbackSettings(settings),
    ...(holdSpeedActive ? { temporaryPlaybackRate: settings.holdPlaybackRate } : {})
  };
}

function publishPlaybackSettings() {
  if (playbackGuest && !playbackGuest.isDestroyed()) {
    playbackGuest.send('player', { cmd: 'preferences', ...guestPlaybackSettings() });
  }
  broadcast('playback:state', playbackState());
}

function showNotice(text) {
  broadcast('app:notice', text);
}

function cyclePlaybackRate() {
  const current = PLAYBACK_RATES.indexOf(settings.playbackRate);
  const playbackRate = PLAYBACK_RATES[(current + 1) % PLAYBACK_RATES.length];
  updatePlaybackSettings(settings, { playbackRate });
  persist();
  publishPlaybackSettings();
  broadcast('settings:changed', settings);
  showNotice(`常规倍速 ${playbackRate}×${holdSpeedActive ? `（长按中 ${settings.holdPlaybackRate}×，松开恢复）` : ''}`);
  return playbackRate;
}

function setHoldSpeed(on) {
  const next = !!on && !!win && !win.isDestroyed();
  if (next === holdSpeedActive) return;
  holdSpeedActive = next;
  publishPlaybackSettings();
  showNotice(next ? `临时 ${settings.holdPlaybackRate}× · 松开恢复 ${settings.playbackRate}×` : `已恢复 ${settings.playbackRate}×`);
}

function cancelTemporarySpeed() {
  setHoldSpeed(false);
  hookHotkeys.cancelHeld();
}

function attachPlaybackGuest(guest) {
  playbackGuest = guest;
  guest.setAudioMuted(true);
  guest.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) guest.setAudioMuted(true);
  });
  guest.once('destroyed', () => {
    if (playbackGuest === guest) playbackGuest = null;
  });
}

/* ------------------------------------------------------------------ 窗口 */

function clampBounds(b) {
  let width = Math.max(240, Math.round(b.width || 896));
  let height = Math.max(150, Math.round(b.height || 568));

  // 老配置是 540×340（2:1 扁条，画面上下被压得只剩一条）。只做一次性纠正，
  // 之后用户自己拉伸的任意比例都尊重，不再干预。
  if (b.aspect !== 2 && width < 720) {
    const maxW = Math.round(screen.getPrimaryDisplay().workArea.width * 0.8);
    width = Math.min(896, maxW);
    height = Math.round((width / 16) * 9) + 64; // 标题栏 30 + 控制条 34
  }

  const area = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(b.x) ? Math.round(b.x) : area.x + area.width - width - 40;
  let y = Number.isFinite(b.y) ? Math.round(b.y) : area.y + 60;

  // 窗口变宽后可能顶出屏幕右边（老配置是贴着右边缘摆的），拉回来。
  // 用窗口所在的那块屏，别把它从副屏拽回主屏。
  const near = screen.getDisplayNearestPoint({ x, y }).workArea;
  if (x + width > near.x + near.width - 8) x = Math.max(near.x + 8, near.x + near.width - width - 40);

  // 保证窗口至少有一部分落在某个屏幕上
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y && y < w.y + w.height - 40;
  });
  if (!visible) {
    x = area.x + area.width - width - 40;
    y = area.y + 60;
  }
  return { x, y, width, height };
}

function applyPin() {
  if (!win || win.isDestroyed()) return;
  if (settings.pinned) {
    // screen-saver 层级：在 Windows 上能压住绝大多数全屏/无边框窗口
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 平台不支持则忽略 */
    }
  } else {
    win.setAlwaysOnTop(false);
  }
}

function createWindow() {
  // 浮窗可以被关掉再重新启动，这里做成幂等
  if (win && !win.isDestroyed()) {
    win.showInactive();
    applyPin();
    return win;
  }

  const bounds = clampBounds(settings.bounds);
  // 老的扁条尺寸被纠正过一次就记下来，之后用户自己拉成什么比例都不再干预
  if (settings.bounds.aspect !== 2) {
    settings.bounds = { ...bounds, aspect: 2 };
    persist();
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0e12',
    show: false,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: true,
    hasShadow: true,
    alwaysOnTop: settings.pinned,
    title: '原神跟跑助手',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  applyPin();
  applyCaptureProtection();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // webview 里的 <video> 一旦走 HTML 全屏，它会铺满整个客户区并盖住我们自己的
  // 标题栏和设置按钮 —— 这是「视频全屏后找不到设置」的根因。直接禁掉，
  // 让 B 站播放器的全屏按钮改走窗口全屏（见 webview-preload 里的 requestFullscreen 改写）。
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.disableHtmlFullscreen = true;
  });
  win.webContents.on('did-attach-webview', (_e, guest) => attachPlaybackGuest(guest));
  win.webContents.on('render-process-gone', () => {
    cancelTemporarySpeed();
    if (win && !win.isDestroyed()) setImmersion(false);
  });

  // 全屏状态回传给渲染页，用来切换「标题栏/控制条浮层化」
  const sendFullscreen = (on) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', { fullscreen: on });
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));

  win.once('ready-to-show', () => {
    win.showInactive(); // 不抢游戏焦点
    applyWindowPresentation();
    notifyFloatState();
  });

  // 窗口失焦后重新压制层级（某些窗口会抢到上面）
  win.on('blur', () => applyPin());

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    // 保留 aspect 标记：用户手动拉过之后就不该在下次启动时被强行改回 16:9
    settings.bounds = { ...settings.bounds, x: b.x, y: b.y, width: b.width, height: b.height, aspect: 2 };
    persist();
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);

  win.on('closed', () => {
    win = null;
    cancelTemporarySpeed();
    clearInterval(hoverTimer);
    hoverTimer = null;
    immersion = false;
    hoverFaded = false;
    // 主窗关了，叠加层不能独自留下，否则 window-all-closed 不触发、进程退不掉
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
    // 字幕跟着视频走：没有视频就没有时间轴，清掉，免得挂着一句停住的字幕
    resetSubtitle();
    resetDanmaku();
    notifyFloatState();
  });
}

/* ---------------------------------------------------------------- 启动器 */

function sendTo(w, channel, payload) {
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** 广播给所有界面窗口：设置改了，两边都要跟上 */
function broadcast(channel, payload) {
  sendTo(win, channel, payload);
  sendTo(consoleWin, channel, payload);
}

function floatState() {
  return { running: !!(win && !win.isDestroyed()), immersion, hoverFaded };
}

function notifyFloatState() {
  broadcast('float:state', floatState());
}

function applyWindowPresentation() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(immersion || settings.clickThrough, { forward: true });
  win.setOpacity(hoverFaded ? Math.min(settings.opacity, 0.1) : settings.opacity);
}

function updateHoverFade() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const inside = immersion && settings.hoverFadeEnabled && win.isVisible() && !win.isMinimized() &&
    point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height;
  if (inside !== hoverCandidate) {
    hoverCandidate = inside;
    hoverCandidateAt = Date.now();
  }
  if (inside === hoverFaded || Date.now() - hoverCandidateAt < 120) return;
  hoverFaded = inside;
  applyWindowPresentation();
  notifyFloatState();
}

function syncHoverFade() {
  clearInterval(hoverTimer);
  hoverTimer = null;
  hoverCandidate = false;
  hoverCandidateAt = Date.now();
  hoverFaded = false;
  applyWindowPresentation();
  if (immersion && settings.hoverFadeEnabled) hoverTimer = setInterval(updateHoverFade, 60);
}

function setImmersion(on) {
  const next = !!on;
  if (next && (!win || win.isDestroyed())) createWindow();
  if (!win || win.isDestroyed()) return false;
  if (next) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
  }
  if (immersion === next) return immersion;
  immersion = next;
  const boundsBefore = win.getBounds();
  win.setResizable(!next);
  win.setMovable(!next);
  const boundsAfter = win.getBounds();
  if (['x', 'y', 'width', 'height'].some((key) => boundsAfter[key] !== boundsBefore[key])) win.setBounds(boundsBefore);
  syncHoverFade();
  sendTo(win, 'win:state', { immersion });
  if (playbackGuest && !playbackGuest.isDestroyed()) playbackGuest.send('player', { cmd: 'presentation', videoOnly: immersion });
  notifyFloatState();
  showNotice(immersion ? `已进入纯视频沉浸 · ${settings.hotkeys.toggleImmersion || '启动器开关'} 退出` : '已退出纯视频沉浸');
  return immersion;
}

/** 启动器窗口：16:9、居中、按工作区留边等比缩放（小屏/125% 缩放也不出界） */
function consoleBounds(work) {
  const maxW = Math.max(800, work.width - 80);
  const maxH = Math.max(450, work.height - 70);
  let width = Math.min(1280, maxW);
  let height = Math.round((width * 9) / 16);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  width = Math.round(width);
  height = Math.round(height);
  return {
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2)
  };
}

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return consoleWin;
  }

  // 首次打开固定 16:9（1280×720 基准），屏幕放不下时等比缩，并居中显示
  const work = screen.getPrimaryDisplay().workArea;
  const box = consoleBounds(work);

  consoleWin = new BrowserWindow({
    width: box.width,
    height: box.height,
    x: box.x,
    y: box.y,
    minWidth: 800,
    minHeight: 450,
    title: '原神跟跑助手 · 启动器',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    // Windows 原生标题栏在浅色系统主题下是一条白条，会和我们自绘的 40px 深色
    // TitleBar 叠成两层。用 Window Controls Overlay 把网页内容延伸到窗口顶部，
    // 最小化/最大化/关闭三个系统按钮浮在深色顶栏右上角（VS Code / Wpf.Ui 同款）。
    // 对应 console.css 里 .topbar 的右侧留白与拖动区域；仅 Windows 有效。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#1e1e1e', symbolColor: '#e6e6e6', height: 40 }
        }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  consoleWin.loadFile(path.join(__dirname, 'console', 'index.html'));

  // 最小化/恢复都补挂一次钩子。Windows 对低级钩子有「钩子过程超时就被静默摘掉」的
  // 规矩，而窗口最小化恰恰会让主进程忙上一阵（窗口销毁、合成器重排），
  // 正好是钩子最容易被打掉的时候；最小化后 1 秒补一次，切回前台再补一次，
  // 用户不必为了热键失灵去重启程序。
  consoleWin.on('minimize', () => setTimeout(() => hookHotkeys.rearm(), 1000));
  consoleWin.on('restore', () => hookHotkeys.rearm());

  consoleWin.once('ready-to-show', () => {
    consoleWin.show();
    notifyFloatState();
  });

  consoleWin.on('closed', () => {
    consoleWin = null;
    // 关启动器就是退出整个应用：跟跑视频窗、方位叠加层、登录窗一起收掉。
    // 旧逻辑只在「浮窗没开」时 quit，于是开着跟跑时关启动器，视频窗会留在
    // 屏幕上、进程也不退出，用户还得再去任务栏手动关一次。
    if (quittingFromConsole) return;
    quittingFromConsole = true;
    for (const w of [win, overlayWin, subWin, dmWin, turnWin, loginWin]) {
      try {
        if (w && !w.isDestroyed()) w.destroy();
      } catch (err) {
        console.warn('[quit] 关闭窗口失败：', err.message);
      }
    }
    app.quit();
  });

  return consoleWin;
}

// 强力置顶：层级被抢时自动恢复
setInterval(() => {
  if (!win || win.isDestroyed() || !settings.pinned) return;
  if (!win.isAlwaysOnTop()) applyPin();
}, 2500);

/* ------------------------------------------------------- 方位标记叠加层 */

let overlayWin = null;
let overlayPlacing = false;
let lastBearing = null;

function overlaySize() {
  // 半径 ×2 再留 12% 余量，箭头尖端才不会贴到窗口边被裁掉
  return Math.round(Math.max(60, Number(settings.bearing.radius) || 110) * 2.24);
}

function overlayBounds() {
  const size = overlaySize();
  const area = screen.getPrimaryDisplay().workArea;
  const cx = Number.isFinite(settings.bearing.x) ? settings.bearing.x : area.x + 260;
  const cy = Number.isFinite(settings.bearing.y) ? settings.bearing.y : area.y + 260;
  return {
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size
  };
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  applyCaptureProtection();

  // 拖动后记住圆心，下次启动原地复活
  overlayWin.on('move', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    settings.bearing.x = Math.round(b.x + b.width / 2);
    settings.bearing.y = Math.round(b.y + b.height / 2);
    persist();
    // 红圈就摆在玩家的小地图上：弹幕的避让区跟着走
    pushDanmakuStyle();
    // 拖到了另一块显示器上：换一个截屏源
    if (locateEnabled() && overlayDisplay().id !== locateDisplayId) sendLocateConfig(false);
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });

  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'));

  overlayWin.webContents.on('did-finish-load', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
    if (lastBearing) overlayWin.webContents.send('bearing', lastBearing);
    sendLocateConfig(true);
  });

  return overlayWin;
}

function showOverlay() {
  const w = createOverlay();
  if (w.isVisible()) return w;

  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) w.showInactive();
    });
  } else {
    w.showInactive();
  }
  return w;
}

function setOverlayPlacing(placing) {
  // 不传参数 = 按当前状态切换。主进程是唯一真相源：以前启动器每次都硬传
  // true，第二下点「锁定位置」又进了一次放置模式，红圈永远锁不上。
  // 显式传 true/false 仍然保留，供热键等需要幂等设置的调用方使用。
  overlayPlacing = placing === undefined || placing === null ? !overlayPlacing : !!placing;
  const w = showOverlay();

  if (overlayPlacing) {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.showInactive();
  } else {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setFocusable(false);
  }

  if (!w.webContents.isLoading()) w.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
  return overlayPlacing;
}

function setBearingEnabled(on) {
  settings.bearing.enabled = !!on;

  if (on) {
    showOverlay();
  } else {
    overlayPlacing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.setFocusable(false);
      overlayWin.hide();
    }
    lastBearing = null;
  }

  if (win && !win.isDestroyed()) win.webContents.send('bearing:state', settings.bearing);
  persist();
  sendLocateConfig(true);
  return settings.bearing;
}

function setOverlayRadius(r) {
  settings.bearing.radius = Math.min(400, Math.max(50, Math.round(Number(r) || 110)));
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setBounds(overlayBounds());
  }
  persist();
  pushDanmakuStyle();
  // 红圈大小变了，之前按视频学到的比例都是相对旧红圈的，作废重学
  settings.bearing.locateScaleBy = {};
  sendLocateConfig(true);
  return settings.bearing.radius;
}

/* -------------------------------------------------------- 视频角色定位 */

/**
 * 叠加层（就是摆在你小地图上的那个红圈窗口）负责匹配和画点；主进程负责：
 *   · 截屏：用 screen-grab.js 的 GDI 小助手，只截红圈（你的小地图）周围一小块；
 *     Chromium 自带的截屏在用户机器上报 NotReadableError，用不了；
 *   · 定位开着时，把本程序所有浮窗标成「不参与截屏」，免得红圈、弹幕、字幕被拍进去污染匹配；
 *   · 视频切片一到，截一块屏，两样一起交给叠加层；
 *   · 按视频保存学到的缩放比例。
 */
let locateKey = '';
let locateDisplayId = null;
let locateStatus = { status: 'off' };
const grabber = createScreenGrabber();
// 截屏统计（写进诊断日志）
const grabDbg = { ok: 0, fail: 0, busy: 0, ms: 0, maxMs: 0, error: '' };

/**
 * 你小地图周围要截的那块屏（屏幕物理像素）和换算参数。
 * 红圈窗口正中 = 你的小地图圆心；红圈半径 = 窗口短边一半 × 0.86（与 overlay.js 的 radius() 一致）。
 * 学习阶段最大会按 1.65 × 1.03 的比例裁，所以截 1.6 × 1.75 倍半径的范围。
 */
function locateGrabRect() {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const b = overlayWin.getBounds();
  const d = screen.getDisplayMatching(b);
  const sf = d.scaleFactor || 1;
  const ringDip = (Math.min(b.width, b.height) / 2) * 0.86;
  const centre = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const ringR = ringDip * sf;
  const half = Math.ceil(1.6 * ringR * 1.75);
  const phys = screen.dipToScreenRect(null, d.bounds);
  const x0 = Math.max(phys.x, centre.x - half);
  const y0 = Math.max(phys.y, centre.y - half);
  const x1 = Math.min(phys.x + phys.width, centre.x + half);
  const y1 = Math.min(phys.y + phys.height, centre.y + half);
  if (x1 - x0 < 16 || y1 - y0 < 16) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, centre, ringR };
}

/** 视频切片到了：截屏，把切片和截图一起交给叠加层（上一张还没截完就丢掉这一帧） */
function grabAndForward(patch) {
  const rect = locateGrabRect();
  if (!rect) return void (locateDbg.drop.noOverlay += 1);
  if (grabber.busy) return void (grabDbg.busy += 1);
  const t0 = Date.now();
  grabber
    .grab(rect.x, rect.y, rect.w, rect.h)
    .then((f) => {
      const ms = Date.now() - t0;
      grabDbg.ok += 1;
      grabDbg.ms = ms;
      grabDbg.maxMs = Math.max(grabDbg.maxMs, ms);
      if (!overlayWin || overlayWin.isDestroyed() || !locateEnabled()) return;
      overlayWin.webContents.send('locate:patch', {
        patch,
        frame: { w: f.w, h: f.h, stride: f.stride, data: f.data, origin: { x: rect.x, y: rect.y }, centre: rect.centre, ringR: rect.ringR }
      });
      locateDbg.forwarded += 1;
      if (locateStatus.status === 'error') {
        locateStatus = { status: 'waiting' };
        sendTo(consoleWin, 'locate:state', { ...locateStatus, enabled: true });
      }
    })
    .catch((err) => {
      if (err.message === 'busy') return void (grabDbg.busy += 1);
      grabDbg.fail += 1;
      grabDbg.error = err.message;
      locateStatus = { status: 'error', message: err.message };
      sendTo(consoleWin, 'locate:state', { ...locateStatus, enabled: true });
    });
}

function locateEnabled() {
  return !!(settings.bearing.enabled && settings.bearing.locate !== false);
}

function applyCaptureProtection() {
  const on = locateEnabled();
  for (const w of [overlayWin, subWin, dmWin, turnWin, win]) {
    if (!w || w.isDestroyed()) continue;
    try {
      // Windows 10 2004+：WDA_EXCLUDEFROMCAPTURE，窗口照常显示，只是截屏 / 录屏里看不到
      w.setContentProtection(on);
    } catch {
      /* 平台不支持 */
    }
  }
}

function overlayDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return screen.getPrimaryDisplay();
  const b = overlayWin.getBounds();
  return screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
}

function sendLocateConfig(reset) {
  applyCaptureProtection();
  if (!locateEnabled()) grabber.stop();
  else grabber.start(); // 提前把 PowerShell 小助手拉起来（首次启动约 1 秒）
  if (!overlayWin || overlayWin.isDestroyed() || overlayWin.webContents.isLoading()) return;
  if (!locateEnabled()) {
    overlayWin.webContents.send('locate:config', { enabled: false });
    return;
  }
  locateDisplayId = overlayDisplay().id;
  const by = settings.bearing.locateScaleBy || {};
  overlayWin.webContents.send('locate:config', {
    enabled: true,
    savedScale: (locateKey && by[locateKey]) || 0,
    reset: !!reset
  });
}

/**
 * 诊断日志：data\locate-debug.log，每 2 秒一行 JSON，把三段链路放在一起：
 *   video   视频页面：发了几张切片、没发的原因（暂停 / 没认出小地图 / 小地图贴边…）
 *   main    主进程：收到几张、转给叠加层几张、丢弃原因
 *   overlay 叠加层：收到几张、截屏是否就绪、交给后台线程几次、算完几次、耗时、错误
 * 文件超过 300KB 就滚动成 .old，不会无限长大。
 */
const locateDbg = { fromVideo: 0, forwarded: 0, drop: { disabled: 0, bad: 0, noOverlay: 0, newVideo: 0 }, overlay: null };

function writeLocateLog(videoDiag) {
  const line = {
    t: new Date().toISOString(),
    locateOn: locateEnabled(),
    bearingOn: !!settings.bearing.enabled,
    overlay: overlayWin && !overlayWin.isDestroyed() ? (overlayWin.isVisible() ? 'visible' : 'hidden') : 'none',
    key: locateKey,
    savedScale: (settings.bearing.locateScaleBy || {})[locateKey] || 0,
    status: locateStatus.status,
    statusMessage: locateStatus.message || '',
    video: videoDiag,
    main: { fromVideo: locateDbg.fromVideo, forwarded: locateDbg.forwarded, drop: locateDbg.drop, grab: { ...grabDbg, helper: grabber.running } },
    overlayDiag: locateDbg.overlay
  };
  Object.assign(grabDbg, { ok: 0, fail: 0, busy: 0, ms: 0, maxMs: 0, error: '' });
  locateDbg.fromVideo = 0;
  locateDbg.forwarded = 0;
  locateDbg.drop = { disabled: 0, bad: 0, noOverlay: 0, newVideo: 0 };
  locateDbg.overlay = null;
  locateDbg.lastVideo = videoDiag;
  try {
    const file = path.join(app.getPath('userData'), 'locate-debug.log');
    try {
      if (fs.statSync(file).size > 300 * 1024) fs.renameSync(file, file + '.old');
    } catch {
      /* 还没有文件 */
    }
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    /* 写不了日志不影响功能 */
  }
  // 「一直在等」时，把卡在哪一段直接告诉启动器
  if (locateEnabled() && (!locateStatus.status || locateStatus.status === 'waiting')) {
    let reason = '';
    if (videoDiag.paused && !videoDiag.sent) reason = 'video-paused';
    else if (videoDiag.noMap && !videoDiag.sent) reason = 'video-no-map';
    else if (videoDiag.edge && !videoDiag.sent) reason = 'video-edge';
    else if (videoDiag.readFail && !videoDiag.sent) reason = 'video-read';
    else if (videoDiag.sent && !line.main.forwarded && line.main.grab.fail) reason = 'no-capture';
    else if (videoDiag.sent && !line.main.forwarded) reason = 'main-drop';
    sendTo(consoleWin, 'locate:state', { ...locateStatus, enabled: true, reason });
  }
}

function setLocateEnabled(on) {
  settings.bearing.locate = !!on;
  persist();
  sendLocateConfig(true);
  if (!on) {
    locateStatus = { status: 'off' };
    sendTo(consoleWin, 'locate:state', { ...locateStatus, enabled: false });
  }
}

/* ------------------------------------------------------------ 游戏内字幕 */

/**
 * 把视频的 CC / AI 字幕单独显示在一块透明置顶窗里，叠在游戏画面上。
 *
 * 为什么不直接用 B 站播放器自带的字幕：那是画在视频里的，浮窗一缩小、
 * 一隐藏（Alt+H）、一调半透明，字幕就跟着看不清。单独一层之后，
 * 视频可以缩到角落甚至藏起来，只留字幕摆在准星下面。
 *
 * 数据流：
 *   浮窗渲染层的播放心跳（id / p / currentTime / 倍速）→ subtitle:time → 主进程
 *   主进程发现换片 / 切 P → 拉字幕轨与字幕 JSON → sub:cues 一次性下发
 *   之后每个心跳 → sub:time 转发，字幕层本地按倍速外推
 *
 * 平时整窗鼠标穿透；「调整位置」进入编辑模式才能拖动、缩放、滚轮调字号。
 */

let subWin = null;
let subEditing = false;
let subToken = 0;
let lastSubTime = null;
let lastSubIdent = null; // 最近一次心跳里的 { id, p }：字幕关着时也记住，打开时直接拉
const subtitleSource = createSubtitleSource((url) => biliFetch(url));

function idleSubtitle(key = '') {
  return { key, tracks: [], track: null, cues: [], state: 'idle', message: '' };
}
let sub = idleSubtitle();

function subtitleDefaultBounds(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 80)
  };
}

function subtitleBounds() {
  const s = settings.subtitle;
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.max(200, Math.round(Number.isFinite(s.width) ? s.width : area.width * 0.6));
  const height = Math.max(60, Math.round(Number.isFinite(s.height) ? s.height : 150));
  const def = subtitleDefaultBounds(width, height);
  let x = Number.isFinite(s.x) ? Math.round(s.x) : def.x;
  let y = Number.isFinite(s.y) ? Math.round(s.y) : def.y;
  // 换过显示器 / 分辨率后可能整块落在屏幕外，拉回默认位置
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.bounds;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y + 20 && y < w.y + w.height - 20;
  });
  if (!visible) ({ x, y } = def);
  return { x, y, width, height };
}

function subtitleStyle() {
  return { fontSize: settings.subtitle.fontSize, bgOpacity: settings.subtitle.bgOpacity };
}

function subtitlePublicState() {
  return {
    enabled: !!settings.subtitle.enabled,
    editing: subEditing,
    state: sub.state,
    message: sub.message,
    lang: settings.subtitle.lang || '',
    current: sub.track ? { lan: sub.track.lan, name: sub.track.name, ai: sub.track.ai } : null,
    tracks: sub.tracks.filter((t) => t.url).map((t) => ({ lan: t.lan, name: t.name, ai: t.ai })),
    count: sub.cues.length
  };
}

function notifySubtitleState() {
  sendTo(consoleWin, 'subtitle:state', subtitlePublicState());
}

function subReady() {
  return !!(subWin && !subWin.isDestroyed() && !subWin.webContents.isLoading());
}

function sendCues() {
  if (subReady()) subWin.webContents.send('sub:cues', { cues: sub.cues, state: sub.state, message: sub.message });
}

function createSubtitleWindow() {
  if (subWin && !subWin.isDestroyed()) return subWin;

  subWin = new BrowserWindow({
    ...subtitleBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 透明窗在 Windows 上靠系统边框缩放不可靠，缩放把手在页面里自绘（subtitle.js）
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: '字幕',
    webPreferences: {
      preload: path.join(__dirname, 'subtitle', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  subWin.setAlwaysOnTop(true, 'screen-saver');
  subWin.setIgnoreMouseEvents(!subEditing);
  subWin.setFocusable(subEditing);
  applyCaptureProtection();

  const remember = () => {
    if (!subWin || subWin.isDestroyed()) return;
    const b = subWin.getBounds();
    Object.assign(settings.subtitle, { x: b.x, y: b.y, width: b.width, height: b.height });
    persist();
  };
  subWin.on('move', remember);
  subWin.on('resize', remember);

  subWin.on('closed', () => {
    subWin = null;
    subEditing = false;
    notifySubtitleState();
  });

  subWin.loadFile(path.join(__dirname, 'subtitle', 'index.html'));
  subWin.webContents.on('did-finish-load', () => {
    if (!subWin || subWin.isDestroyed()) return;
    subWin.webContents.send('sub:style', subtitleStyle());
    subWin.webContents.send('sub:mode', subEditing ? 'edit' : 'lock');
    sendCues();
    if (lastSubTime) subWin.webContents.send('sub:time', lastSubTime);
  });

  return subWin;
}

function showSubtitleWindow() {
  const w = createSubtitleWindow();
  if (w.isVisible()) return w;
  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed() && settings.subtitle.enabled) w.showInactive();
    });
  } else {
    w.showInactive();
  }
  return w;
}

/** 视频窗关掉时清空：没有时间轴了 */
function resetSubtitle() {
  subToken += 1;
  sub = idleSubtitle();
  lastSubTime = null;
  lastSubIdent = null;
  subLive = false;
  if (subReady()) subWin.webContents.send('sub:live', '');
  sendCues();
  notifySubtitleState();
}

/** 按当前语言偏好挑轨并下载字幕正文；只改传进来的那份状态，过期的结果直接丢 */
async function applySubtitleTrack(cur, token) {
  const track = pickTrack(cur.tracks, settings.subtitle.lang);
  const cues = track ? await subtitleSource.loadCues(track) : [];
  if (token !== subToken) return;
  cur.track = track;
  cur.cues = cues;
  cur.state = cues.length ? 'ready' : 'none';
  cur.message = cues.length ? '' : '这条字幕是空的';
}

/**
 * 字幕轨的来源优先级：
 *  1. 跟跑浮窗里的 B 站页面上报的（webview-preload 旁听播放器 / 带 Cookie 主动请求）——
 *     页面带着真实登录态，AI 字幕只有这条路稳定拿得到；
 *  2. 等了 PAGE_TRACK_WAIT_MS 页面还没报，才用主进程自己的请求兜底；
 *  3. 有轨但正文下不下来：让页面打开播放器自带的 CC，转发屏幕上的实时字幕（state = 'live'）。
 *
 * key 一律小写：页面报上来的、浮窗心跳带的 BV 号大小写不一定一致。
 */
const PAGE_TRACK_WAIT_MS = 6000;
const pageTracks = new Map(); // key -> { tracks, needLogin }
let pageWaiter = null; // { key, resolve, timer }
let subLive = false;

function subKey(id, p) {
  return id ? `${String(id).toLowerCase()}#${p}` : '';
}

function setGuestLive(on) {
  subLive = !!on;
  if (playbackGuest && !playbackGuest.isDestroyed()) playbackGuest.send('player', { cmd: 'subtitle-live', on: subLive });
  if (!subLive && subReady()) subWin.webContents.send('sub:live', '');
}

function waitForPageTracks(key) {
  return new Promise((resolve) => {
    if (pageWaiter) {
      clearTimeout(pageWaiter.timer);
      pageWaiter.resolve(null);
    }
    const w = {
      key,
      resolve,
      timer: setTimeout(() => {
        if (pageWaiter === w) pageWaiter = null;
        resolve(null);
      }, PAGE_TRACK_WAIT_MS)
    };
    pageWaiter = w;
  });
}

function goLive(cur) {
  cur.state = 'live';
  cur.message = '正在读取播放器里的字幕（实时模式）';
  setGuestLive(true);
}

/**
 * 拿到字幕轨之后的统一处理；只改传进来的 cur，过期结果直接丢。
 * entry = { tracks, needLogin, hasCc }；hasCc = 页面里播放器有 CC 按钮，说明这一集确实有字幕。
 */
async function applySubtitleTracks(cur, token, entry) {
  const { tracks, needLogin, hasCc } = entry;
  cur.tracks = tracks;
  if (tracks.some((t) => t.url)) {
    try {
      await applySubtitleTrack(cur, token);
    } catch {
      /* 正文下载 / 解析失败，下面走实时兜底 */
    }
    if (token !== subToken) return;
    if (cur.state !== 'ready') goLive(cur);
    return;
  }
  // 接口没给出能下载的地址，但播放器自己有 CC：直接读播放器屏幕上的字幕
  if (hasCc) {
    goLive(cur);
    return;
  }
  cur.state = 'none';
  cur.message = needLogin
    ? '没有找到字幕：AI 字幕要先在启动器里登录 B 站'
    : '这个视频没有字幕（UP 主没上传，B 站也没生成 AI 字幕）';
}

function finishSubtitleLoad(token) {
  if (token !== subToken) return;
  sendCues();
  notifySubtitleState();
}

async function loadSubtitleFor(id, p) {
  const key = subKey(id, p);
  const token = ++subToken;
  const cur = idleSubtitle(key);
  sub = cur;
  setGuestLive(false);
  apPrev = null;
  apLiveHit = '';
  if (key) {
    cur.state = 'loading';
    cur.message = '正在读取字幕…';
  }
  sendCues();
  notifySubtitleState();
  if (!key) return;

  let entry = pageTracks.get(key) || null;
  if (!entry) entry = await waitForPageTracks(key);
  if (token !== subToken) return;

  if (entry) {
    await applySubtitleTracks(cur, token, entry);
  } else {
    try {
      const { tracks, needLogin } = await subtitleSource.loadTracks(id, p);
      if (token !== subToken) return;
      await applySubtitleTracks(cur, token, { tracks, needLogin, hasCc: false });
    } catch (err) {
      if (token !== subToken) return;
      cur.state = 'error';
      cur.message = '读取字幕失败：' + (err && err.message ? err.message : err);
    }
  }
  finishSubtitleLoad(token);
}

/** 页面（带登录态）上报的字幕轨 */
function onPageSubtitleTracks(msg) {
  const p = Math.max(1, Math.floor(Number(msg.p) || 1));
  const key = subKey(msg.id, p);
  if (!key) return;
  const entry = {
    ...tracksFromPlayerData({
      subtitle: { subtitles: Array.isArray(msg.subtitles) ? msg.subtitles.slice(0, 20) : [] },
      login_mid: msg.loggedIn ? 1 : 0,
      need_login_subtitle: !!msg.needLoginSubtitle
    }),
    hasCc: !!msg.hasCc
  };
  pageTracks.delete(key);
  pageTracks.set(key, entry);
  if (pageTracks.size > 20) pageTracks.delete(pageTracks.keys().next().value);

  if (pageWaiter && pageWaiter.key === key) {
    const w = pageWaiter;
    pageWaiter = null;
    clearTimeout(w.timer);
    w.resolve(entry);
    return;
  }
  if (key !== sub.key) return;
  // 实时模式中：后到了能下载的字幕轨就换成按时间轴的正式字幕；否则只是页面重载，重新打开实时读取
  if (sub.state === 'live' && !(entry.tracks.some((t) => t.url) && !sub.tracks.some((t) => t.url))) {
    setGuestLive(true);
    return;
  }
  if (sub.state === 'live') {
    const token = ++subToken;
    const cur = sub;
    setGuestLive(false);
    applySubtitleTracks(cur, token, entry).finally(() => finishSubtitleLoad(token));
    return;
  }
  // 主进程兜底已经下了「没字幕 / 出错」的结论，页面后到的完整列表要能翻盘
  // （包括：先到的 player/v2 是空的，后到的新接口 / CC 按钮说其实有字幕）
  if ((sub.state === 'none' || sub.state === 'error') && (entry.tracks.some((t) => t.url) || entry.hasCc)) {
    const token = ++subToken;
    const cur = sub;
    cur.state = 'loading';
    cur.message = '正在读取字幕…';
    notifySubtitleState();
    applySubtitleTracks(cur, token, entry).finally(() => finishSubtitleLoad(token));
  }
}

/** 实时模式：播放器屏幕上的那一行字幕 */
function onPageSubtitleLive(text) {
  if (sub.state !== 'live') return;
  const line = String(text || '').slice(0, 500);
  checkAutoPauseLive(line);
  if (subReady()) subWin.webContents.send('sub:live', line);
}

/* ---- 自动暂停：字幕说到「过完剧情」就停 ---- */

let apPrev = null; // 上一个心跳的播放时间，用来判断「这一句刚刚说完」
let apLiveHit = ''; // 实时模式：正在显示的、命中关键词的那句
let apCompiled = { sig: '', list: [] };

function pauseKeywords() {
  const words = settings.autoPause.keywords;
  const sig = words.join('\u0001');
  if (apCompiled.sig !== sig) apCompiled = { sig, list: compileKeywords(words) };
  return apCompiled.list;
}

/** 字幕数据要不要拉：字幕层开着，或者自动暂停开着（它也要靠字幕判断） */
function subtitleNeeded() {
  return !!(settings.subtitle.enabled || settings.autoPause.enabled);
}

function autoPauseVideo(line) {
  if (!playbackGuest || playbackGuest.isDestroyed()) return;
  playbackGuest.send('player', { cmd: 'pause' });
  const key = settings.hotkeys.togglePlay || 'Alt+Space';
  const short = String(line || '').replace(/\s+/g, ' ').slice(0, 40);
  const text = `⏸ 已自动暂停：「${short}」· 过完剧情按 ${key} 继续`;
  showNotice(text);
  // 浮窗可能被游戏压住 / 被隐藏，字幕层上也亮一下
  if (subReady()) subWin.webContents.send('sub:notice', text);
}

/** 按时间轴：心跳从 prev 走到 t 的这段里，有命中的那句说完了就停 */
function checkAutoPause(t, playing) {
  const prev = apPrev;
  apPrev = t;
  if (!settings.autoPause.enabled || !playing || prev === null || sub.state !== 'ready') return;
  // 倒退、或者一下跳了好几秒（拖进度条 / 快进），不算「听完了这句」
  if (t <= prev || t - prev > 2.5) return;
  const hit = crossedPauseCue(sub.cues, prev, t, pauseKeywords());
  if (hit) autoPauseVideo(hit.cue.text);
}

/** 实时模式没有时间轴：命中的那句从屏幕上消失（说完了）时停 */
function checkAutoPauseLive(text) {
  if (!settings.autoPause.enabled) return;
  const hit = text && matchKeyword(text, pauseKeywords()) ? text : '';
  if (apLiveHit && apLiveHit !== text) {
    const line = apLiveHit;
    apLiveHit = hit;
    if (lastSubTime && lastSubTime.playing) autoPauseVideo(line);
    return;
  }
  apLiveHit = hit;
}

function ensureSubtitleLoaded() {
  if (!subtitleNeeded() || !lastSubIdent) return;
  const { id, p } = lastSubIdent;
  if (subKey(id, p) !== sub.key) loadSubtitleFor(id, p);
}

/** 登录状态变了（扫码登录成功）：同一个视频也要重拉，AI 字幕这时才拿得到 */
function reloadSubtitle() {
  // 登录前缓存的「要登录」结论全部作废，并让页面带新 Cookie 重新问一次
  pageTracks.clear();
  if (playbackGuest && !playbackGuest.isDestroyed()) playbackGuest.send('player', { cmd: 'subtitle-refresh' });
  sub.key = '';
  ensureSubtitleLoaded();
}

function onSubtitleTime(msg) {
  const id = String((msg && msg.id) || '');
  const p = Math.max(1, Math.floor(Number(msg && msg.p) || 1));
  lastSubIdent = id ? { id, p } : null;
  lastSubTime = {
    current: Number(msg.current) || 0,
    playing: !!msg.playing && !!msg.found,
    rate: Number(msg.rate) || 1,
    at: Date.now()
  };
  ensureSubtitleLoaded();
  checkAutoPause(lastSubTime.current, lastSubTime.playing);
  if (subReady()) subWin.webContents.send('sub:time', lastSubTime);
  onDanmakuTime(lastSubTime);
}

function setSubtitleEnabled(on) {
  settings.subtitle.enabled = !!on;
  if (on) {
    showSubtitleWindow();
    // 重新打开时把当前状态再推一次：没字幕的原因会在画面上再亮几秒
    sendCues();
    ensureSubtitleLoaded();
  } else {
    subEditing = false;
    if (subWin && !subWin.isDestroyed()) {
      subWin.setIgnoreMouseEvents(true);
      subWin.setFocusable(false);
      if (!subWin.webContents.isLoading()) subWin.webContents.send('sub:mode', 'lock');
      subWin.hide();
    }
  }
  persist();
  broadcast('settings:changed', settings);
  notifySubtitleState();
  return subtitlePublicState();
}

/** 不传参数 = 切换；主进程是唯一真相源，和方位叠加层的「放置 / 锁定」同一套路 */
function setSubtitleEditing(on) {
  const next = on === undefined || on === null ? !subEditing : !!on;
  if (next && !settings.subtitle.enabled) setSubtitleEnabled(true);
  subEditing = next;
  const w = subWin && !subWin.isDestroyed() ? subWin : null;
  if (w) {
    w.setIgnoreMouseEvents(!subEditing);
    w.setFocusable(subEditing);
    if (subEditing) w.showInactive();
    if (!w.webContents.isLoading()) w.webContents.send('sub:mode', subEditing ? 'edit' : 'lock');
  }
  notifySubtitleState();
  return subEditing;
}

function setSubtitleStyle(patch = {}) {
  const s = settings.subtitle;
  if (Number.isFinite(patch.fontSize)) s.fontSize = Math.min(72, Math.max(14, Math.round(patch.fontSize)));
  if (Number.isFinite(patch.bgOpacity)) s.bgOpacity = Math.min(0.9, Math.max(0, Number(patch.bgOpacity)));
  let langChanged = false;
  if (typeof patch.lang === 'string' && patch.lang !== s.lang) {
    s.lang = patch.lang.slice(0, 32);
    langChanged = true;
  }
  if (subReady()) subWin.webContents.send('sub:style', subtitleStyle());
  persist();
  broadcast('settings:changed', settings);

  if (langChanged && sub.tracks.some((t) => t.url)) {
    const token = ++subToken;
    const cur = sub;
    cur.state = 'loading';
    cur.message = '正在切换字幕…';
    notifySubtitleState();
    applySubtitleTrack(cur, token)
      .catch((err) => {
        if (token !== subToken) return;
        cur.state = 'error';
        cur.message = '读取字幕失败：' + err.message;
      })
      .finally(() => {
        if (token !== subToken) return;
        sendCues();
        notifySubtitleState();
      });
  } else {
    notifySubtitleState();
  }
  return subtitlePublicState();
}

/* ------------------------------------------------------------ 全屏弹幕 */

/**
 * 一块透明、鼠标穿透、铺满主屏的窗口，像 B 站一样让弹幕从右往左飘。
 * 时间轴和字幕共用浮窗的播放心跳；弹幕数据由主进程按 cid 拉整集 XML。
 *
 * 不挡小地图：原神的小地图在左上角，正好落在弹幕区里。弹幕层在那一块整块不画
 * （裁掉而不是让轨道绕开，滚动弹幕从右边过来，到了地图那里就「消失」，过了再出现）。
 * 位置优先用「方位标定」里摆在玩家小地图上的红圈（settings.bearing.x / y / radius，屏幕坐标），
 * 没摆过就按原神默认 UI 布局估算（小地图圆心约在 0.144H, 0.111H，半径约 0.088H）。
 */

let dmWin = null;
let dmToken = 0;
let dm = { key: '', items: [], state: 'idle', message: '' };

function danmakuDisplayBounds() {
  return screen.getPrimaryDisplay().bounds;
}

/** 小地图避让区（弹幕窗自己的坐标系）；关了避让就返回 null */
function danmakuMask() {
  if (!settings.danmaku.avoidMap) return null;
  const d = danmakuDisplayBounds();
  const b = settings.bearing || {};
  let cx = d.x + d.height * 0.144;
  let cy = d.y + d.height * 0.111;
  let r = d.height * 0.088;
  const placed =
    Number.isFinite(b.x) && Number.isFinite(b.y) &&
    b.x >= d.x && b.x < d.x + d.width && b.y >= d.y && b.y < d.y + d.height;
  if (placed) {
    cx = b.x;
    cy = b.y;
    r = Math.max(40, Number(b.radius) || r);
  }
  // 比圆本身大一圈：外面还有罗盘刻度、方位箭头叠加层和地名 / 时间小字
  const x1 = cx + r * 1.45;
  const y1 = cy + r * 1.55;
  return {
    x: 0,
    y: 0,
    w: Math.round(Math.max(0, x1 - d.x)),
    h: Math.round(Math.max(0, y1 - d.y))
  };
}

function danmakuStyle() {
  const s = settings.danmaku;
  return { opacity: s.opacity, fontSize: s.fontSize, duration: s.duration, area: s.area, mask: danmakuMask() };
}

function dmReady() {
  return !!(dmWin && !dmWin.isDestroyed() && !dmWin.webContents.isLoading());
}

function pushDanmakuStyle() {
  if (dmReady()) dmWin.webContents.send('dm:style', danmakuStyle());
}

function sendDanmakuItems() {
  if (dmReady()) dmWin.webContents.send('dm:items', { items: dm.items });
}

function danmakuPublicState() {
  return { enabled: !!settings.danmaku.enabled, state: dm.state, message: dm.message, count: dm.items.length };
}

function notifyDanmakuState() {
  sendTo(consoleWin, 'danmaku:state', danmakuPublicState());
}

function fitDanmakuWindow() {
  if (dmWin && !dmWin.isDestroyed()) dmWin.setBounds(danmakuDisplayBounds());
  pushDanmakuStyle();
}

function createDanmakuWindow() {
  if (dmWin && !dmWin.isDestroyed()) return dmWin;
  dmWin = new BrowserWindow({
    ...danmakuDisplayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: '弹幕',
    webPreferences: {
      preload: path.join(__dirname, 'danmaku', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  dmWin.setAlwaysOnTop(true, 'screen-saver');
  // 永远穿透：弹幕层盖满整个屏幕，绝不能吃掉游戏的鼠标
  dmWin.setIgnoreMouseEvents(true);
  applyCaptureProtection();
  dmWin.on('closed', () => {
    dmWin = null;
  });
  dmWin.loadFile(path.join(__dirname, 'danmaku', 'index.html'));
  dmWin.webContents.on('did-finish-load', () => {
    if (!dmWin || dmWin.isDestroyed()) return;
    dmWin.webContents.send('dm:style', danmakuStyle());
    sendDanmakuItems();
    if (lastSubTime) dmWin.webContents.send('dm:time', lastSubTime);
  });
  return dmWin;
}

function showDanmakuWindow() {
  const w = createDanmakuWindow();
  if (w.isVisible()) return w;
  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed() && settings.danmaku.enabled) w.showInactive();
    });
  } else {
    w.showInactive();
  }
  return w;
}

function resetDanmaku() {
  dmToken += 1;
  dm = { key: '', items: [], state: 'idle', message: '' };
  sendDanmakuItems();
  notifyDanmakuState();
}

async function loadDanmakuFor(id, p) {
  const key = subKey(id, p);
  const token = ++dmToken;
  dm = { key, items: [], state: key ? 'loading' : 'idle', message: key ? '正在读取弹幕…' : '' };
  sendDanmakuItems();
  notifyDanmakuState();
  if (!key) return;
  try {
    const items = await subtitleSource.loadDanmaku(id, p);
    if (token !== dmToken) return;
    dm.items = items;
    dm.state = items.length ? 'ready' : 'none';
    dm.message = items.length ? '' : '这个视频还没有弹幕';
  } catch (err) {
    if (token !== dmToken) return;
    dm.state = 'error';
    dm.message = '读取弹幕失败：' + (err && err.message ? err.message : err);
  }
  sendDanmakuItems();
  notifyDanmakuState();
}

function ensureDanmakuLoaded() {
  if (!settings.danmaku.enabled || !lastSubIdent) return;
  const { id, p } = lastSubIdent;
  if (subKey(id, p) !== dm.key) loadDanmakuFor(id, p);
}

function onDanmakuTime(t) {
  ensureDanmakuLoaded();
  if (dmReady() && t) dmWin.webContents.send('dm:time', t);
}

function setDanmakuEnabled(on) {
  settings.danmaku.enabled = !!on;
  if (on) {
    showDanmakuWindow();
    ensureDanmakuLoaded();
  } else if (dmWin && !dmWin.isDestroyed()) {
    dmWin.hide();
  }
  persist();
  broadcast('settings:changed', settings);
  notifyDanmakuState();
  return danmakuPublicState();
}

function setDanmakuStyle(patch = {}) {
  const s = settings.danmaku;
  if (Number.isFinite(patch.opacity)) s.opacity = Math.min(1, Math.max(0.1, Number(patch.opacity)));
  if (Number.isFinite(patch.fontSize)) s.fontSize = Math.min(48, Math.max(14, Math.round(patch.fontSize)));
  if (Number.isFinite(patch.duration)) s.duration = Math.min(20, Math.max(3, Number(patch.duration)));
  if (Number.isFinite(patch.area)) s.area = Math.min(1, Math.max(0.1, Number(patch.area)));
  if (typeof patch.avoidMap === 'boolean') s.avoidMap = patch.avoidMap;
  pushDanmakuStyle();
  persist();
  broadcast('settings:changed', settings);
  return danmakuPublicState();
}

/* ------------------------------------------------------------ 转向提醒 */

/**
 * 博主左转 / 右转 / 掉头时在屏幕上弹一个提示（turn/index.html）。
 * 判定在 turn-detect.js，输入就是红箭头那一路行进方向（overlay:bearing）。
 * 窗口透明、鼠标穿透、置顶；位置可在启动器里「调整位置」拖动，记住。
 */
let turnWin = null;
let turnEditing = false;
const turnDetector = createTurnDetector({ minTurn: 60 });

function turnBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 340;
  const height = 130;
  const t = settings.turn;
  let x = Number.isFinite(t.x) ? Math.round(t.x) : Math.round(area.x + (area.width - width) / 2);
  let y = Number.isFinite(t.y) ? Math.round(t.y) : Math.round(area.y + area.height * 0.16);
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.bounds;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y + 20 && y < w.y + w.height - 20;
  });
  if (!visible) {
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + area.height * 0.16);
  }
  return { x, y, width, height };
}

function createTurnWindow() {
  if (turnWin && !turnWin.isDestroyed()) return turnWin;
  turnWin = new BrowserWindow({
    ...turnBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: '转向提醒',
    webPreferences: {
      preload: path.join(__dirname, 'turn', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  turnWin.setAlwaysOnTop(true, 'screen-saver');
  turnWin.setIgnoreMouseEvents(!turnEditing);
  turnWin.setFocusable(turnEditing);
  applyCaptureProtection();
  turnWin.on('move', () => {
    if (!turnWin || turnWin.isDestroyed()) return;
    const b = turnWin.getBounds();
    settings.turn.x = b.x;
    settings.turn.y = b.y;
    persist();
  });
  turnWin.on('closed', () => {
    turnWin = null;
    turnEditing = false;
  });
  turnWin.loadFile(path.join(__dirname, 'turn', 'index.html'));
  turnWin.webContents.on('did-finish-load', () => {
    if (turnWin && !turnWin.isDestroyed()) turnWin.webContents.send('turn:mode', turnEditing ? 'edit' : 'lock');
  });
  return turnWin;
}

function showTurnWindow() {
  const w = createTurnWindow();
  if (w.isVisible()) return w;
  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed() && settings.turn.enabled) w.showInactive();
    });
  } else {
    w.showInactive();
  }
  return w;
}

/** 红箭头的每一次更新都喂给转向检测；画面里没小地图时清空，免得两段不相干的方向被拼成一次「转弯」 */
function onBearingForTurn(p) {
  if (!settings.turn.enabled || !p) return;
  if (typeof p.angle !== 'number') {
    if (!p.hold) turnDetector.reset();
    return;
  }
  if (p.hold) return; // 疑似反向的那一帧不算数
  const ev = turnDetector.push(p.angle, Date.now());
  if (ev && turnWin && !turnWin.isDestroyed() && !turnWin.webContents.isLoading()) {
    if (!turnWin.isVisible()) turnWin.showInactive();
    turnWin.webContents.send('turn:show', ev);
  }
}

function setTurnEditing(on) {
  const next = on === undefined || on === null ? !turnEditing : !!on;
  if (next && !settings.turn.enabled) {
    settings.turn.enabled = true;
    persist();
  }
  turnEditing = next;
  const w = next ? showTurnWindow() : turnWin;
  if (w && !w.isDestroyed()) {
    w.setIgnoreMouseEvents(!turnEditing);
    w.setFocusable(turnEditing);
    if (!w.webContents.isLoading()) w.webContents.send('turn:mode', turnEditing ? 'edit' : 'lock');
  }
  sendTo(consoleWin, 'turn:state', { enabled: !!settings.turn.enabled, editing: turnEditing });
  return turnEditing;
}

function setTurnSettings(patch = {}) {
  const t = settings.turn;
  if (typeof patch.enabled === 'boolean') {
    t.enabled = patch.enabled;
    if (t.enabled) showTurnWindow();
    else {
      if (turnEditing) setTurnEditing(false);
      if (turnWin && !turnWin.isDestroyed()) turnWin.hide();
      turnDetector.reset();
    }
  }
  if (Number.isFinite(patch.minTurn)) {
    t.minTurn = Math.min(120, Math.max(30, Math.round(patch.minTurn)));
    turnDetector.setMinTurn(t.minTurn);
  }
}

/* -------------------------------------------------------------- 全局热键 */

function sendPlayerAction(action) {
  // 浮窗没起来时热键也要有反应：否则用户在启动器里按键，什么都不发生
  if (!win || win.isDestroyed()) {
    createWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
      });
    }
    return;
  }
  win.webContents.send('hotkey', action);
}

/** 热键动作的唯一入口：键盘加速器和鼠标侧键都走这里 */
function handleHotkey(key, phase) {
  if (key === 'holdSpeed') return setHoldSpeed(phase === 'down');
  if (capturingHotkey) return;
  if (key === 'cycleSpeed' && (typingInField || (loginWin && !loginWin.isDestroyed() && BrowserWindow.getFocusedWindow() === loginWin))) return;
  if (key === 'cycleSpeed') return cyclePlaybackRate();
  if (key === 'toggleImmersion') return setImmersion(!immersion);
  if (key === 'toggleVisible') return toggleVisible();
  if (key === 'togglePass') return setPass(!settings.clickThrough);
  if (key === 'toggleOpacity') return setOpacity(settings.opacity > 0.95 ? 0.65 : 1);
  if (key === 'toggleSubtitle') {
    const on = setSubtitleEnabled(!settings.subtitle.enabled).enabled;
    showNotice(on ? '游戏内字幕已开启' : '游戏内字幕已关闭');
    return;
  }
  if (key === 'toggleDanmaku') {
    const on = setDanmakuEnabled(!settings.danmaku.enabled).enabled;
    showNotice(on ? '全屏弹幕已开启' : '全屏弹幕已关闭');
    return;
  }
  if (key === 'moveSubtitle') {
    const editing = setSubtitleEditing();
    showNotice(editing ? '拖动字幕到合适位置，再按一次锁定' : '字幕位置已锁定');
    return;
  }
  sendPlayerAction(key);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    applyPin();
  }
}

function setPass(on) {
  settings.clickThrough = !!on;
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { clickThrough: settings.clickThrough });
}

function setOpacity(v) {
  settings.opacity = Math.min(1, Math.max(0.3, Number(v) || 1));
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { opacity: settings.opacity });
}

function registerHotkeys() {
  cancelTemporarySpeed();
  globalShortcut.unregisterAll();
  failedHotkeys = [];

  for (const { key } of HOTKEY_META) {
    const acc = settings.hotkeys[key];
    if (!acc) continue;
    // 鼠标侧键和单键不进 globalShortcut：前者不支持，后者会把键全局吞掉。
    // 这两类统一交给低级钩子被动监听。
    if (hookHotkeys.isHookAccelerator(acc, key)) continue;

    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => handleHotkey(key));
    } catch {
      ok = false;
    }
    if (!ok) failedHotkeys.push({ key, accelerator: acc });
  }

  // 钩子类绑定：不可用时要把涉及的动作全部标为失败，界面才解释得清
  const hookState = hookHotkeys.apply(
    settings.hotkeys,
    handleHotkey,
    /**
     * 什么时候不响应单键/侧键。
     *
     * 原来这里是「自己的任一窗口在前台就全部忽略」，代价太大：浮窗本身就是
     * 置顶播放器，用户点一下它、或者刚在启动器里配完热键就按 J 试试，
     * 都会被判成「在自己的窗口里」，表现得就像热键彻底没接上。
     *
     * 现在只挡两种确实会打架的情形：正在输入框里打字、正在录制新键位。
     * 登录窗例外：那里面一定要能正常输入账号密码。
     */
    () => {
      if (capturingHotkey) return true;
      if (typingInField) return true;
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && focused === loginWin;
    }
  );

  if (hookState.needed && !hookState.ok) {
    for (const { key } of HOTKEY_META) {
      const acc = settings.hotkeys[key];
      if (hookHotkeys.isHookAccelerator(acc, key)) failedHotkeys.push({ key, accelerator: acc, hook: true });
    }
  }
  for (const acc of hookState.keys) {
    const hit = HOTKEY_META.find((m) => settings.hotkeys[m.key] === acc);
    if (hit) failedHotkeys.push({ key: hit.key, accelerator: acc, unsupported: true });
  }

  if (failedHotkeys.length) {
    console.warn('[hotkeys] 注册失败（可能被其他程序占用）:', failedHotkeys);
  }
  return failedHotkeys;
}

/* ------------------------------------------------------------ B 站解析 */

async function followRedirect(url) {
  try {
    const res = await biliFetch(url, { Accept: 'text/html' });
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    return res.url || url;
  } catch {
    return url;
  }
}

function extractId(text) {
  const s = String(text || '').trim();
  let m = s.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return 'BV' + m[0].slice(2);
  m = s.match(/[?&/]av(\d+)/i) || s.match(/^av(\d+)$/i);
  if (m) return 'av' + m[1];
  return null;
}

async function resolveInput(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, message: '请输入视频链接或 BV 号' };

  if (/b23\.tv|bili2233\.cn/i.test(s)) {
    const direct = s.match(/https?:\/\/\S+/i);
    if (direct) s = await followRedirect(direct[0]);
  }

  const id = extractId(s);
  if (!id) return { ok: false, message: '没认出 BV 号，请粘贴完整视频链接' };

  const pm = s.match(/[?&](?:p|page)=(\d+)/i);
  return { ok: true, id, p: pm ? Number(pm[1]) : 1 };
}

async function fetchVideoInfo(id) {
  const q = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
    const json = await res.json();
    if (json.code !== 0) return { ok: false, message: json.message || `接口返回 ${json.code}` };
    const d = json.data || {};
    return {
      ok: true,
      id: d.bvid || id,
      title: d.title || '',
      owner: d.owner ? d.owner.name : '',
      pages: (d.pages || []).map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
    };
  } catch (err) {
    return { ok: false, message: '读取视频信息失败：' + err.message };
  }
}

/** 查询登录态：未登录只能看预览/低清晰度，登录后才是完整视频 */
async function fetchNav() {
  try {
    const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    const json = await res.json();
    const d = json.data || {};
    return {
      ok: true,
      loggedIn: !!d.isLogin,
      uname: d.uname || '',
      mid: d.mid || 0,
      vip: d.vipStatus === 1,
      level: d.level_info ? d.level_info.current_level : 0
    };
  } catch (err) {
    return { ok: false, loggedIn: false, uname: '', message: err.message };
  }
}

/** 只用 www.bilibili.com 视频页：站外嵌入播放器（player.bilibili.com）无论如何都上不了高清 */
function buildUrl(id, p) {
  const page = Math.max(1, Number(p) || 1);
  const key = id.startsWith('av') ? `av${id.slice(2)}` : id;
  return `https://www.bilibili.com/video/${key}/?p=${page}&autoplay=1`;
}

/* ---------------------------------------------------------------- 登录 */

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    if (loginWin.isMinimized()) loginWin.restore();
    loginWin.show();
    loginWin.focus();
    return;
  }

  const currentLoginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录 B 站',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      partition: BILI_PARTITION,
      // 当前 Windows / Electron 组合的沙箱登录页会直接 ERR_FAILED，连本地页也无法加载。
      // 仅此窗口兼容运行；远程页面不接入 preload / Node / 应用 IPC。
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  loginWin = currentLoginWindow;
  // 跟跑浮窗使用 screen-saver 层级，登录窗口也要到同层，才能显示在它上面。
  currentLoginWindow.setAlwaysOnTop(true, 'screen-saver');
  currentLoginWindow.show();
  currentLoginWindow.focus();
  currentLoginWindow.loadURL('https://passport.bilibili.com/login').catch((err) => {
    console.warn('[bili] 登录页面加载失败：', err.message);
  });

  // 查询单飞，避免网络慢时 interval 重入，扫码后重复通知、重载播放器。
  let checking = false;
  let completed = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  const timer = setInterval(async () => {
    if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    if (checking) return;
    checking = true;
    try {
      const nav = await fetchNav();
      // 用户可能在接口返回前关闭窗口，或者已经重新打开了另一个登录窗口。
      if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || !nav.loggedIn) return;
      completed = true;
      clearInterval(timer);
      console.log('[bili] 登录成功：', nav.uname, nav.vip ? '(大会员)' : '');
      broadcast('login:state', nav);
      reloadSubtitle();
      currentLoginWindow.close();
    } finally {
      checking = false;
    }
  }, 2000);

  currentLoginWindow.on('closed', () => {
    completed = true;
    clearInterval(timer);
    if (loginWin === currentLoginWindow) loginWin = null;
  });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  // 这里只读写内存；访客 preload 在站点脚本之前同步拿到偏好。
  ipcMain.on('player:settings', (event) => {
    if (!isPlaybackGuest(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      event.returnValue = null;
      return;
    }
    event.sender.setAudioMuted(true);
    playbackGate = 0;
    event.returnValue = { ...guestPlaybackSettings(), token: ++playbackToken, ...(immersion ? { videoOnly: true } : {}) };
  });
  ipcMain.on('player:gating', (event, message) => {
    if (isPlaybackMessage(event, message) && Number.isSafeInteger(message.seq) && message.seq > playbackGate) {
      playbackGate = message.seq;
      event.sender.setAudioMuted(true);
    }
  });
  ipcMain.on('player:ready', (event, message) => {
    if (isPlaybackMessage(event, message) && message.seq === playbackGate) event.sender.setAudioMuted(false);
  });
  ipcMain.on('player:changed', (event, message) => {
    if (!isPlaybackMessage(event, message)) {
      event.returnValue = null;
      return;
    }
    const patch = { ...(message.patch || {}) };
    if (holdSpeedActive) delete patch.playbackRate;
    if (updatePlaybackSettings(settings, patch)) {
      persist();
      broadcast('settings:changed', settings);
    }
    // 同步完成：紧接着切 P 的新 preload 也能读到用户刚调好的值。
    event.returnValue = guestPlaybackSettings();
  });

  ipcMain.handle('app:boot', async () => {
    const nav = await fetchNav();
    console.log(
      '[bili] 登录态：',
      nav.loggedIn ? `已登录 ${nav.uname}${nav.vip ? '（大会员）' : ''}` : '未登录',
      nav.ok ? '' : `接口异常 ${nav.message || ''}`
    );
    return {
      settings,
      floatState: floatState(),
      playbackState: playbackState(),
      hotkeys: HOTKEY_META,
      failedHotkeys,
      initialUrl: OPEN_ARG,
      nav,
      // 框选圆环的出厂初值。**不进标定列表**，只用来决定第一次打开标定时圆环落在哪，
      // 免得一打开就偏到画面外、用户点「完成」直接存下一个错区域。
      seedRoi: SEED_ROI,
      webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).href,
      version: app.getVersion(),
      // 界面要能一眼看出「单键/侧键的全局钩子到底起来了没有」，
      // 否则热键不响应时只能靠猜
      hookRunning: hookHotkeys.isRunning(),
      // 没提权时游戏内热键必然收不到（UIPI），界面要直说，别让用户怀疑程序坏了
      elevated: isElevated(),
      // 让启动器能显示「设置和登录态存在哪」，绿色版就是 exe 同级的 data\
      dataDir: app.getPath('userData'),
      portable: installMode === 'portable',
      installMode
    };
  });

  ipcMain.handle('bili:nav', () => fetchNav());

  /* ---- 提权重启：游戏内热键要管理员身份才行（UIPI），由用户按需触发 ---- */
  ipcMain.handle('app:relaunch-elevated', async () => {
    if (isElevated()) return { ok: false, reason: 'already-elevated' };
    // 先让出单实例锁：提权后的新进程启动时会申请它。不让出的话新进程会立刻自杀，
    // 而这边也已经退出 —— 用户看到的现象就是「点了按钮，程序直接消失」。
    if (saveTimer) flushSettings();
    const hadLock = app.hasSingleInstanceLock();
    if (hadLock) app.releaseSingleInstanceLock();
    const result = await relaunchElevated();
    // UAC 被取消：把锁要回来，继续以普通权限运行
    if (!result.ok && hadLock) app.requestSingleInstanceLock();
    if (result.ok) setTimeout(() => app.exit(0), 400);
    return result;
  });

  /* ---- 输入状态：决定单键热键要不要让路 ---- */

  ipcMain.on('ui:typing', (_e, on) => {
    typingInField = !!on;
    if (typingInField) cancelTemporarySpeed();
  });
  ipcMain.on('ui:capture', (_e, on) => {
    capturingHotkey = !!on;
    if (capturingHotkey) cancelTemporarySpeed();
  });

  /* ---- 方位标记：视频侧只上报一个角度，主进程转发给叠加窗 ---- */

  ipcMain.on('overlay:bearing', (_e, payload) => {
    lastBearing = payload;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('bearing', payload);
    onBearingForTurn(payload);
  });
  ipcMain.handle('turn:edit', (_e, on) => setTurnEditing(on));

  ipcMain.handle('overlay:enable', (_e, on) => setBearingEnabled(on));

  /* ---- 视频角色定位 ---- */

  // 浮窗页面送来的博主小地图切片：换视频了先让叠加层重置（带上这个视频之前学到的比例），再转过去
  ipcMain.on('locate:patch', (event, p) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    locateDbg.fromVideo += 1;
    if (!locateEnabled()) return void (locateDbg.drop.disabled += 1);
    if (!p || !p.gray) return void (locateDbg.drop.bad += 1);
    if (!overlayWin || overlayWin.isDestroyed()) return void (locateDbg.drop.noOverlay += 1);
    const key = String(p.id || p.vid || '');
    if (key !== locateKey) {
      locateKey = key;
      sendLocateConfig(true);
      return void (locateDbg.drop.newVideo += 1);
    }
    grabAndForward(p);
  });
  // 诊断：视频页面每 2 秒报一次（为什么发 / 没发切片），叠加层同样报一次；合起来写进 data\locate-debug.log
  ipcMain.on('locate:diag', (event, d) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !d) return;
    writeLocateLog(d);
  });
  ipcMain.on('locate:odiag', (event, d) => {
    if (!overlayWin || overlayWin.isDestroyed() || event.sender !== overlayWin.webContents || !d) return;
    locateDbg.overlay = d;
  });
  // 诊断截图：视频切片 / 按比例裁出的你的小地图 / 截图整块（红圈 = 算法认为的你的小地图），覆盖写
  ipcMain.on('locate:dump', (event, d) => {
    if (!overlayWin || overlayWin.isDestroyed() || event.sender !== overlayWin.webContents || !d) return;
    const dir = app.getPath('userData');
    for (const [name, url] of [['locate-video.png', d.video], ['locate-game.png', d.game], ['locate-capture.png', d.whole]]) {
      const b64 = String(url || '').split(',')[1];
      if (!b64) continue;
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
      } catch {
        /* ignore */
      }
    }
  });
  // 叠加层第一次锁定了这个视频的缩放比例：存下来，下次打开这个视频直接用
  ipcMain.on('locate:learned', (event, scale) => {
    if (!overlayWin || overlayWin.isDestroyed() || event.sender !== overlayWin.webContents) return;
    if (!locateKey || !Number.isFinite(scale) || scale < 0.3 || scale > 3) return;
    settings.bearing.locateScaleBy = { ...(settings.bearing.locateScaleBy || {}), [locateKey]: Math.round(scale * 1000) / 1000 };
    persist();
  });
  ipcMain.on('locate:status', (event, s) => {
    if (!overlayWin || overlayWin.isDestroyed() || event.sender !== overlayWin.webContents || !s) return;
    locateStatus = { status: String(s.status || ''), scale: Number(s.scale) || 0, message: String(s.message || '').slice(0, 200) };
    sendTo(consoleWin, 'locate:state', { ...locateStatus, enabled: locateEnabled() });
  });
  ipcMain.handle('locate:state', () => ({ ...locateStatus, enabled: locateEnabled() }));

  /**
   * 手动自动定心的结果。访客算出的 dx/dy 是「视频像素」，这里换算成归一化偏移，
   * 直接写进该视频的标定（roiBy[id] 优先，否则全局 rois）——这就是「固定住」：
   * 下次打开还是对准的，浮窗里的临时修正也会随新标定归零。
   *
   * 只接受 ok && applied 的结果；失败 / 取消不改任何标定。
   */
  ipcMain.handle('bearing:auto-center-result', (_e, res) => {
    const p = res && typeof res === 'object' ? res : {};
    let out = { ok: !!p.ok, applied: !!p.applied, reason: p.reason || '' };

    if (p.ok && p.applied) {
      const b = settings.bearing || (settings.bearing = {});
      const rawId = String(p.videoId || settings.lastVideoId || '');
      const keys = Object.keys(b.roiBy || {});
      const key = rawId && b.roiBy && b.roiBy[rawId] ? rawId : keys.find((k) => k.toLowerCase() === rawId.toLowerCase());
      const own = key && Array.isArray(b.roiBy[key]) && b.roiBy[key].length ? b.roiBy[key] : null;
      const list = own || (Array.isArray(b.rois) ? b.rois : null);
      const idx = Math.max(0, Math.min(Number(p.roiIndex) || 0, (list ? list.length : 0) - 1));
      const roi = list && list[idx];

      if (roi && Number.isFinite(p.dcx) && Number.isFinite(p.dcy)) {
        roi.cx = Math.min(0.999, Math.max(0.001, roi.cx + p.dcx));
        roi.cy = Math.min(0.999, Math.max(0.001, roi.cy + p.dcy));
        if (own) b.roiBy[key] = list;
        else b.rois = list;
        // 自动定心成功本身就说明这块区域已经对准，别再提示「还没标定」
        b.calibrated = true;
        persist();
        // 两边都通知：浮窗会拿新标定重挂识别，启动器刷新文案
        broadcast('settings:changed', settings);
        out = { ok: true, applied: true, dx: p.dx, dy: p.dy, roi };
      } else {
        out = { ok: false, applied: false, reason: 'save-failed' };
      }
    }

    // 启动器也要看到结果（浮窗这时可能被游戏压住，用户看不到它的 toast）
    sendTo(consoleWin, 'auto-center-result', out);
    return out;
  });
  /* ---- 游戏内字幕 ---- */

  // 播放心跳只认跟跑浮窗自己的页面，别的窗口不能伪造时间轴
  ipcMain.on('subtitle:time', (event, msg) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (msg && typeof msg === 'object') onSubtitleTime(msg);
  });
  ipcMain.on('subtitle:tracks', (event, msg) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (msg && typeof msg === 'object') onPageSubtitleTracks(msg);
  });
  ipcMain.on('subtitle:live', (event, text) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    onPageSubtitleLive(text);
  });
  ipcMain.handle('subtitle:enable', (_e, on) => setSubtitleEnabled(on));
  ipcMain.handle('subtitle:edit', (_e, on) => setSubtitleEditing(on));
  ipcMain.handle('subtitle:style', (_e, patch) => setSubtitleStyle(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('subtitle:state', () => subtitlePublicState());

  /* ---- 全屏弹幕 ---- */
  ipcMain.handle('danmaku:enable', (_e, on) => setDanmakuEnabled(on));
  ipcMain.handle('danmaku:style', (_e, patch) => setDanmakuStyle(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('danmaku:state', () => danmakuPublicState());
  // 编辑模式下字幕层自绘把手拖出来的新尺寸；只在编辑模式、且只认字幕窗自己
  ipcMain.on('subtitle:set-bounds', (event, b) => {
    if (!subEditing || !subWin || subWin.isDestroyed() || event.sender !== subWin.webContents || !b) return;
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
    subWin.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(200, Math.round(b.width)),
      height: Math.max(60, Math.round(b.height))
    });
  });

  ipcMain.handle('overlay:place', (_e, on) => setOverlayPlacing(on));
  // 启动器重建 / 箭头开关切换后，用它把按钮文案对齐到主进程的真实状态
  ipcMain.handle('overlay:place-state', () => overlayPlacing);
  ipcMain.handle('overlay:radius', (_e, r) => setOverlayRadius(r));

  // 调试：把访客抓到的识别区域落盘，用来肉眼确认 ROI 有没有对准小地图
  ipcMain.handle('overlay:dump-save', (_e, payload = {}) => {
    const dir = app.getPath('userData');
    const b64 = String(payload.dataUrl || '').split(',')[1] || '';
    if (!b64) return { ok: false, file: '' };

    const file = path.join(dir, 'bearing-dump.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));

    // 整帧 + 红框图：用来肉眼判断识别区域有没有落在小地图上
    const fb64 = String(payload.frame || '').split(',')[1] || '';
    const frameFile = path.join(dir, 'bearing-frame.png');
    if (fb64) fs.writeFileSync(frameFile, Buffer.from(fb64, 'base64'));

    const rois = Array.isArray(payload.rois) ? payload.rois : [];
    const roiText = rois
      .map((r) => `(${r.cx.toFixed(3)}, ${r.cy.toFixed(3)}) r=${r.r.toFixed(3)}`)
      .join(' | ');

    console.log(
      '[bearing] 识别区域已导出',
      `${payload.size}px`,
      `视频 ${payload.vw}×${payload.vh}`,
      `${rois.length} 处：${roiText || '无'}`,
      `不透明 ${payload.opaque}/${payload.total}`,
      `→ ${frameFile}`
    );
    return { ok: true, file, frameFile: fb64 ? frameFile : '', dir, size: payload.size };
  });

  // 导出后让用户在资源管理器里直接看到，不用自己翻 AppData
  ipcMain.handle('overlay:reveal-dump', () => {
    const dir = app.getPath('userData');
    const frame = path.join(dir, 'bearing-frame.png');
    if (fs.existsSync(frame)) shell.showItemInFolder(frame);
    else shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('settings:save', (_e, patch = {}) => {
    const playbackChanged = updatePlaybackSettings(settings, patch);
    if (HOLD_PLAYBACK_RATES.includes(patch.holdPlaybackRate)) settings.holdPlaybackRate = patch.holdPlaybackRate;
    if (typeof patch.hoverFadeEnabled === 'boolean') {
      settings.hoverFadeEnabled = patch.hoverFadeEnabled;
      syncHoverFade();
      notifyFloatState();
    }
    if (playbackChanged || patch.holdPlaybackRate !== undefined) publishPlaybackSettings();
    // 自动连播 / 手动切 P 只带 lastPart：页码和时间要一起刷新，
    // 否则启动器上的「上次看到」会一直停在第一次打开视频那一刻。
    if (patch.lastText !== undefined || patch.lastPart !== undefined) {
      noteWatched(settings, {
        ...(patch.lastText !== undefined ? { text: patch.lastText } : {}),
        ...(patch.lastPart !== undefined ? { p: patch.lastPart } : {})
      });
    }
    // 这个开关本身不是「观看记录」，别顺手刷新 lastWatchedAt
    if (patch.resumeOnLaunch !== undefined) settings.resumeOnLaunch = !!patch.resumeOnLaunch;
    if (patch.pinned !== undefined) {
      settings.pinned = !!patch.pinned;
      applyPin();
    }
    if (patch.clickThrough !== undefined) setPass(patch.clickThrough);
    if (patch.opacity !== undefined) setOpacity(patch.opacity);
    if (patch.hotkeys) settings.hotkeys = { ...settings.hotkeys, ...patch.hotkeys };
    if (patch.turn && typeof patch.turn === 'object') setTurnSettings(patch.turn);
    if (patch.autoPause && typeof patch.autoPause === 'object') {
      const ap = patch.autoPause;
      if (typeof ap.enabled === 'boolean') settings.autoPause.enabled = ap.enabled;
      if (typeof ap.keywords === 'string') {
        const words = parseKeywordText(ap.keywords);
        settings.autoPause.keywords = words.length ? words : DEFAULT_PAUSE_KEYWORDS.slice();
      }
      // 打开自动暂停时字幕层可能是关着的，字幕数据要单独拉起来
      ensureSubtitleLoaded();
    }
    if (patch.bearing) {
      const b = patch.bearing;
      if (b.calibrated !== undefined) settings.bearing.calibrated = !!b.calibrated;
      if (typeof b.locate === 'boolean') setLocateEnabled(b.locate);
      // 视频里的小地图重新框过：这个视频之前学到的缩放比例作废
      if (Array.isArray(b.rois) && b.videoId && settings.bearing.locateScaleBy) {
        delete settings.bearing.locateScaleBy[b.videoId];
        if (b.videoId === locateKey) sendLocateConfig(true);
      }

      if (Array.isArray(b.rois)) {
        const rois = dropLegacySeeds(b.rois).slice(0, 4);
        settings.bearing.rois = rois;
        if (b.videoId) {
          // 清空时必须把这个视频的专属记录一起删掉。以前只清全局 rois，
          // roiBy 里还留着 —— 看着「清除本视频标定」成功了，重载视频又回来了，
          // 因为取区域时优先读 roiBy。
          if (rois.length) settings.bearing.roiBy[b.videoId] = rois;
          else delete settings.bearing.roiBy[b.videoId];
        }
      }
    }
    persist();
    broadcast('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('hotkeys:update', (_e, next = {}) => {
    const valid = {};
    for (const [k, v] of Object.entries(next)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, k) && typeof v === 'string' && v.trim()) {
        valid[k] = v.trim();
      }
    }

    const previous = { ...settings.hotkeys };
    const prepared = prepareHotkeyUpdate(previous, valid);
    settings.hotkeys = prepared.hotkeys;
    let failed = registerHotkeys();
    let rejected = prepared.rejected;
    const affected = new Set([...Object.keys(valid), ...prepared.swapped]);
    // 换键是一个事务：隐式互换的另一方注册失败，也必须一起退回。
    if (failed.some((failure) => affected.has(failure.key))) {
      settings.hotkeys = previous;
      rejected = Object.keys(valid);
      failed = registerHotkeys();
    }
    persist();
    broadcast('settings:changed', settings);
    return {
      hotkeys: settings.hotkeys,
      failed,
      rejected,
      swapped: rejected.length ? [] : prepared.swapped,
      hookRunning: hookHotkeys.isRunning()
    };
  });

  ipcMain.handle('hotkeys:reset', () => {
    settings.hotkeys = { ...DEFAULT_HOTKEYS };
    const failed = registerHotkeys();
    persist();
    broadcast('settings:changed', settings);
    return { hotkeys: settings.hotkeys, failed, hookRunning: hookHotkeys.isRunning() };
  });

  ipcMain.handle('win:action', (_e, action, payload) => {
    // 下面这几个动作主要由启动器发起，而启动器点它们的时候浮窗往往还没起，
    // 所以必须放在「浮窗存在」的守卫之前；否则按钮点了没有任何反应。
    switch (action) {
      case 'start-float':
        createWindow();
        return true;
      case 'stop-float':
        if (win && !win.isDestroyed()) win.close();
        return true;
      case 'open-console':
        createConsole();
        return true;
      case 'login':
        cancelTemporarySpeed();
        openLogin();
        return true;
      case 'immersion':
        return setImmersion(payload === undefined ? !immersion : !!payload);
      case 'cycle-speed':
        return cyclePlaybackRate();
      case 'open-data':
        shell.openPath(app.getPath('userData'));
        return true;
      case 'open-license':
        return shell.openPath(app.isPackaged
          ? path.join(process.resourcesPath, 'licenses', 'NOTICE-GIFA.txt')
          : path.join(app.getAppPath(), 'build', 'LICENSE.txt'));
      case 'calib':
        // 框选要看着视频拖圆环，只能在浮窗里做 —— 这里负责把它叫起来
        if (!win || win.isDestroyed()) createWindow();
        if (immersion) setImmersion(false);
        sendTo(win, 'float:cmd', { cmd: 'calib' });
        return true;
      case 'autocenter': {
        // 自动定心也只在浮窗里做：浮窗没起就先起，等它加载完再把命令递过去
        const fresh = !win || win.isDestroyed();
        if (fresh) createWindow();
        const send = () => sendTo(win, 'float:cmd', { cmd: 'autocenter' });
        if (fresh) setTimeout(send, 1500);
        else send();
        return true;
      }
      case 'dump':
        if (win && !win.isDestroyed()) sendTo(win, 'float:cmd', { cmd: 'dump' });
        return true;
      case 'float-load':
        if (win && !win.isDestroyed()) {
          sendTo(win, 'float:cmd', { cmd: 'load', text: payload && payload.text, p: payload && payload.p });
        }
        return true;
      default:
        break;
    }

    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        break;
      case 'close':
        // 只关跟跑浮窗，不退出程序 —— 启动器还在，随时可以再点「启动跟跑」。
        // 反方向不一样：关启动器会连带收掉所有窗口并退出（见 createConsole）。
        win.close();
        break;
      case 'hide':
        toggleVisible();
        break;
      case 'pin':
        settings.pinned = !!payload;
        applyPin();
        persist();
        break;
      case 'pass':
        setPass(payload);
        break;
      case 'opacity':
        setOpacity(payload);
        break;
      case 'fullscreen':
        // 纯视频模式锁住窗口尺寸，网页内部的全屏请求不改变它。
        if (immersion) return false;
        // payload 省略时按当前状态取反，方便同一个入口做开关
        win.setFullScreen(payload === undefined ? !win.isFullScreen() : !!payload);
        break;
      case 'resize':
        if (immersion) return false;
        if (payload && Number.isFinite(payload.w) && Number.isFinite(payload.h)) {
          win.setBounds({
            x: win.getBounds().x,
            y: win.getBounds().y,
            width: Math.max(240, Math.round(payload.w)),
            height: Math.max(150, Math.round(payload.h))
          });
        }
        break;
      default:
        break;
    }
    return true;
  });

  ipcMain.handle('bili:load', async (_e, payload = {}) => {
    const resolved = await resolveInput(payload.text);
    if (!resolved.ok) return { ok: false, message: resolved.message };

    const p = Number(payload.p) || resolved.p || 1;
    const info = await fetchVideoInfo(resolved.id);
    const id = (info.ok && info.id) || resolved.id;
    const pages = info.ok ? info.pages : [];

    // 同一视频切 P 时接口偶尔读不到分 P 信息，别把已知的标题/总数清掉
    const sameVideo =
      settings.lastVideoId &&
      String(settings.lastVideoId).toLowerCase() === String(id).toLowerCase();
    noteWatched(settings, {
      text: payload.text,
      p,
      id,
      title: info.ok ? info.title : sameVideo ? settings.lastTitle : '',
      pageCount: pages.length || (sameVideo ? settings.lastPageCount : 0)
    });
    persist();
    // 启动器可能正开着：让「上次看到」那一行立刻跟上，不用等下次启动
    broadcast('settings:changed', settings);

    return {
      ok: true,
      id,
      p,
      url: buildUrl(id, p),
      title: info.ok ? info.title : '',
      owner: info.ok ? info.owner : '',
      pages,
      message: info.ok ? '' : `读不到分 P 信息（${info.message}），已直接载入`
    };
  });
}

/* ---------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 exe 时把启动器叫回来，而不是只动浮窗
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show();
      consoleWin.focus();
    } else {
      createConsole();
    }
  });

  app.whenReady().then(async () => {
    // 打包版已在 exe 清单层提权（双击即弹 UAC），这里**不再自动重启**：
    // portable 版是「自解压壳 + 主程序」，运行时再提权等于多解压一遍 100MB、多等 20 秒。
    // 只有清单没生效时（开发版 / 解压直跑 / UAC 被取消），启动器顶部横幅仍提供
    // 「以管理员身份重启」作为兜底。
    // 常驻工具：明确告诉系统「别挂起我」。配合上面的 EcoQoS 开关，
    // 保证窗口最小化后全局钩子照常工作（这正是「在游戏里按热键」的核心场景）。
    powerSaveBlocker.start('prevent-app-suspension');
    if (process.platform === 'win32') app.setAppUserModelId('com.finallawer.genshin-route-buddy');
    powerMonitor.on('suspend', cancelTemporarySpeed);
    powerMonitor.on('lock-screen', cancelTemporarySpeed);
    powerMonitor.on('resume', () => {
      cancelTemporarySpeed();
      hookHotkeys.rearm();
    });

    loadSettings();
    // 调试用：本次启动强制打开方位标记，不写进设置文件
    if (process.argv.includes('--bearing')) settings.bearing.enabled = true;
    try {
      session.defaultSession.setUserAgent(UA);
    } catch {
      /* ignore */
    }
    registerIpc();
    createConsole(); // 先出启动器，配置好了再点「启动跟跑」
    registerHotkeys();

    // `--open BVxxx` 是从快捷方式直接带视频来的，那就顺手把浮窗也起来
    if (OPEN_ARG) createWindow();
    // 「上次看到」：直接把浮窗起来，浮窗 init() 会读 lastText/lastPart 继续播。
    // 显式 --open 优先；开关可在启动器里关掉（只想改设置、不想每次弹浮窗时）。
    else if (shouldResumeOnLaunch(settings, OPEN_ARG)) {
      console.log('[resume] 继续上次观看', settings.lastTitle || settings.lastText, `P${settings.lastPart}`);
      createWindow();
    }

    if (settings.bearing.enabled && win) showOverlay();
    if (settings.subtitle.enabled) showSubtitleWindow();
    if (settings.danmaku.enabled) showDanmakuWindow();
    if (settings.turn.enabled) showTurnWindow();
    turnDetector.setMinTurn(settings.turn.minTurn);
    // 换分辨率 / 插拔显示器：弹幕层要重新铺满主屏
    screen.on('display-metrics-changed', fitDanmakuWindow);
    screen.on('display-added', fitDanmakuWindow);
    screen.on('display-removed', fitDanmakuWindow);

    // 只允许登录窗口弹 B 站域名的子窗口（第三方登录/扫码），其余一律拦截
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        const isBili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com([/?#:]|$)/i.test(url);
        const fromLogin =
          loginWin && !loginWin.isDestroyed() && contents === loginWin.webContents;
        if (fromLogin && isBili) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
        }
        return { action: 'deny' };
      });
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    clearInterval(hoverTimer);
    grabber.stop();
    cancelTemporarySpeed();
    if (saveTimer) flushSettings();
    globalShortcut.unregisterAll();
    try {
      hookHotkeys.apply({}, null); // 清空映射并停止钩子
    } catch (err) {
      // 退出路径上的异常会弹出 Electron 的报错框，这里必须兜住
      console.warn('[hook] 退出前停止钩子失败：', err.message);
    }
  });
}
