#!/usr/bin/env python3
"""shotctl: scan, fix, host and manage Shot Caller without Railway.

One file, Python 3.9+ standard library only. Run it from anywhere; it finds the repo it lives in.

  Code
    scan                 check Node, dependencies, syntax of every .js file, the tests, .env and git
    fix                  apply the safe fixes scan suggests (install deps, create .env with secrets, data folder)
    env [list|set|unset] the server's variables, kept in .env (what Railway's Variables tab used to hold)

  Host it yourself (a real app and website)
    run                  run the server in the foreground, restarting it if it crashes (like Railway's ON_FAILURE)
    start / stop / restart / status / logs
                         the same server in the background, with a pid file and a log file
    deploy               pull the latest code, install, test, restart, health-check, and roll back if it fails
    tunnel               a public https:// address for this machine through Cloudflare (no domain, no port forwarding)
    install-service      write a systemd unit (starts on boot) and a Caddyfile (HTTPS for your own domain)

  The live app (local or anywhere it's hosted)
    live health          /healthz: version, storage, bot, Discord, auto-trader
    live login           sign in with the admin code; the session is saved for the other live commands
    live members         list members        live approve CODE [--days N]   live deny CODE   live revoke CODE
    live config          set the price / access days      live tuneup [--run]      live hiring
    live record          the public record shown on the website

Examples
  python3 scripts/shotctl.py scan
  python3 scripts/shotctl.py fix
  python3 scripts/shotctl.py env set ADMIN_CODE=my-secret-code APP_URL=https://shotcaller.example.com
  python3 scripts/shotctl.py deploy
  python3 scripts/shotctl.py tunnel
  python3 scripts/shotctl.py live login --url https://shotcaller.example.com
  python3 scripts/shotctl.py live approve AB12CD --days 30
"""
from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env'
RUN_DIR = ROOT / 'data' / '.shotctl'  # data/ is git-ignored
PID_FILE = RUN_DIR / 'server.pid'
LOG_FILE = RUN_DIR / 'server.log'
STATE_DIR = Path.home() / '.shotctl'
CONF_FILE = STATE_DIR / 'config.json'

# Variables that hold secrets: masked when listed
SECRET_KEYS = re.compile(r'SECRET|TOKEN|KEY|CODE|WEBHOOK|PRIVATE', re.I)
# Variables the server reads (grep of process.env / env.X), so `env set` can warn about typos
KNOWN_VARS = set('''
ACCESS_DAYS ACCESS_SECRET ADMIN_CODE ANTHROPIC_API_KEY APP_URL ASK_AI ASK_MODEL AUTO_MAX_ORDER_USD AUTO_SERIES
BOT_INTERVAL_MS CASHTAG COINBASE_API CROSS DATA_DIR DISCORD_ALERTS DISCORD_ALERTS_WEBHOOK_URL DISCORD_ALERT_MARKETS
DISCORD_BOT_TOKEN DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_GUILD_ID DISCORD_INVITE DISCORD_LIQ_MIN
DISCORD_REDIRECT_URI DISCORD_ROLE_ID DISCORD_WEBHOOK_URL DISCORD_WHALES DISCORD_WHALE_MIN FUTURES INDEX KALSHI_API
KALSHI_DEMO_API KEY_SECRET LEARN MARKETS MARKETS_EXTRA MARKETS_FREQ MARKETS_OFF NEWS NEWS_CALENDAR NEWS_COINDESK
NEWS_GOOGLE NEWS_EVERY_MIN PAYWALL PAYWALL_PRICE PLAYBOOK PORT PUSH_HOST_ALLOW SCAN_FEEDS TUNEUP_AUTO TUNEUP_EVERY_H
VAPID_PRIVATE_KEY VAPID_PUBLIC_KEY VAPID_SUBJECT WHALE_ALERT_API_KEY WHALE_FILTER_MIN YAHOO_API
'''.split())

WINDOWS = os.name == 'nt'
# variables this tool reads (not the server): TUNNEL_TOKEN runs your named Cloudflare tunnel in `up`
TOOL_VARS = {'TUNNEL_TOKEN'}
USE_COLOR = sys.stdout.isatty() and os.environ.get('NO_COLOR') is None


def paint(code: str, text: str) -> str:
    return f'\033[{code}m{text}\033[0m' if USE_COLOR else text


def ok(msg: str) -> None: print(f"  {paint('32', 'OK  ')} {msg}")
def warn(msg: str) -> None: print(f"  {paint('33', 'WARN')} {msg}")
def bad(msg: str) -> None: print(f"  {paint('31', 'FAIL')} {msg}")
def step(msg: str) -> None: print(paint('1', f'\n== {msg}'))


def die(msg: str, code: int = 1) -> None:
    print(paint('31', f'error: {msg}'), file=sys.stderr)
    sys.exit(code)


def sh(cmd: list[str], *, check: bool = True, capture: bool = False, env: dict | None = None, timeout: int | None = None):
    """Run a command in the repo. capture=True returns the CompletedProcess with text output."""
    # Windows runs npm as npm.cmd, which subprocess only finds by its full path
    cmd = [shutil.which(cmd[0]) or cmd[0], *cmd[1:]]
    try:
        return subprocess.run(cmd, cwd=ROOT, check=check, text=True, env=env, timeout=timeout,
                              stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None)
    except FileNotFoundError:
        die(f'{cmd[0]} is not installed')


# ---------- .env ----------

def read_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not ENV_FILE.exists():
        return out
    for line in ENV_FILE.read_text().splitlines():
        m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if not m or line.lstrip().startswith('#'):
            continue
        val = m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
            val = val[1:-1]
        out[m.group(1)] = val
    return out


def write_env(updates: dict[str, str | None]) -> None:
    """Set (or, with None, remove) variables in .env, keeping comments and order."""
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    seen = set()
    new: list[str] = []
    for line in lines:
        m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
        if m and not line.lstrip().startswith('#') and m.group(1) in updates:
            key = m.group(1)
            seen.add(key)
            if updates[key] is not None:
                new.append(f'{key}={quote(updates[key])}')
            continue
        new.append(line)
    for key, val in updates.items():
        if key not in seen and val is not None:
            new.append(f'{key}={quote(val)}')
    ENV_FILE.write_text('\n'.join(new) + '\n')
    os.chmod(ENV_FILE, 0o600)


def quote(val: str) -> str:
    return f'"{val}"' if re.search(r'\s|#|"|\'', val) else val


def mask(key: str, val: str) -> str:
    if not SECRET_KEYS.search(key) or not val:
        return val
    return val[:3] + '…' + f'({len(val)} chars)'


def server_env() -> dict[str, str]:
    env = {**os.environ, **read_env()}
    env.setdefault('PORT', '8080')
    env.setdefault('DATA_DIR', str(ROOT / 'data'))
    return env


def port() -> int:
    return int(server_env().get('PORT', 8080))


# ---------- scan ----------

def node_version() -> tuple[int, ...] | None:
    if not shutil.which('node'):
        return None
    out = sh(['node', '--version'], capture=True, check=False).stdout.strip().lstrip('v')
    try:
        return tuple(int(x) for x in out.split('.'))
    except ValueError:
        return None


def deps_installed() -> bool:
    pkg = json.loads((ROOT / 'package.json').read_text())
    return all((ROOT / 'node_modules' / name / 'package.json').exists() for name in pkg.get('dependencies', {}))


def js_files() -> list[Path]:
    skip = {'node_modules', 'vendor', '.git', 'data', 'video'}
    return sorted(p for p in ROOT.rglob('*.js') if not skip & set(p.relative_to(ROOT).parts))


def cmd_scan(args) -> int:
    problems = 0
    fixable: list[str] = []

    step('Toolchain')
    nv = node_version()
    if nv is None:
        bad('Node.js not found. Install Node 22+ (https://nodejs.org) and run scan again.'); problems += 1
    elif nv[0] < 22:
        bad(f'Node {".".join(map(str, nv))} is too old: the server needs Node 22+'); problems += 1
    else:
        ok(f'Node {".".join(map(str, nv))}')
    if shutil.which('npm'):
        ok('npm')
    else:
        bad('npm not found'); problems += 1
    if deps_installed():
        ok('dependencies installed')
    else:
        warn('dependencies not installed (fix: npm ci)'); fixable.append('deps')

    step('Code')
    files = js_files()
    broken = []
    if nv:
        for f in files:
            r = sh(['node', '--check', str(f)], capture=True, check=False)
            if r.returncode:
                broken.append((f, r.stdout.strip().splitlines()[:6]))
    if broken:
        for f, msg in broken:
            bad(f'syntax error in {f.relative_to(ROOT)}')
            for line in msg:
                print(f'         {line}')
        problems += len(broken)
    else:
        ok(f'{len(files)} JavaScript files parse')
    try:
        manifest = json.loads((ROOT / 'public' / 'manifest.webmanifest').read_text())
        ok(f'PWA manifest: {manifest.get("name", "?")}')
    except (OSError, ValueError) as e:
        bad(f'public/manifest.webmanifest: {e}'); problems += 1
    version = json.loads((ROOT / 'package.json').read_text()).get('version')
    ok(f'version {version}')

    if not args.no_tests:
        step('Tests (npm test)')
        if nv and deps_installed():
            r = sh(['npm', 'test', '--silent'], capture=True, check=False, timeout=args.test_timeout)
            summary = [l for l in r.stdout.splitlines() if re.match(r'^[#ℹ] (tests|pass|fail|cancelled|duration_ms)', l)]
            for line in summary:
                print(f'         {line}')
            if r.returncode:
                failing = [l.strip() for l in r.stdout.splitlines() if re.match(r'^\s*not ok ', l) or l.lstrip().startswith('✖')]
                for line in failing[:15]:
                    print(f'         {line}')
                bad('tests failed (see above; run `npm test` for the full output)'); problems += 1
            else:
                ok('all tests pass')
        else:
            warn('skipped: install Node 22+ and the dependencies first')

    step('Settings (.env)')
    env = read_env()
    if not ENV_FILE.exists():
        warn('no .env yet (fix: creates one with fresh secrets)'); fixable.append('env')
    else:
        unknown = sorted(k for k in env if k not in KNOWN_VARS | TOOL_VARS)
        for k in unknown:
            warn(f'{k} is set but the server never reads it (typo?)')
        if not env.get('ADMIN_CODE'):
            warn('ADMIN_CODE not set: the built-in admin code is in use. Set your own: env set ADMIN_CODE=...')
        if not env.get('ACCESS_SECRET'):
            warn('ACCESS_SECRET not set: saved access passes depend on the data folder surviving (fix sets one)'); fixable.append('env')
        if not (env.get('VAPID_PUBLIC_KEY') and env.get('VAPID_PRIVATE_KEY')):
            warn('VAPID keys not pinned: phones resubscribe if the data folder is lost (fix sets them)'); fixable.append('env')
        if not env.get('APP_URL'):
            warn('APP_URL not set: the website and Discord links have no public address (set it once you have a domain or tunnel)')
        if env.get('APP_URL') and not env['APP_URL'].startswith('https://'):
            bad('APP_URL must start with https://'); problems += 1
        if env.get('ADMIN_CODE') or env.get('ACCESS_SECRET'):
            ok('.env present')
    if not WINDOWS and ENV_FILE.exists() and ENV_FILE.stat().st_mode & 0o077:
        warn('.env is readable by other users (fix: chmod 600)'); fixable.append('perms')
    tracked = sh(['git', 'ls-files', '--error-unmatch', '.env'], capture=True, check=False) if shutil.which('git') else None
    if tracked and tracked.returncode == 0:
        bad('.env is committed to git: your secrets are public. Remove it with `git rm --cached .env` and rotate them'); problems += 1

    step('Data')
    data = Path(server_env()['DATA_DIR'])
    if data.is_dir() and os.access(data, os.W_OK):
        ok(f'data folder {data} is writable (members, record, what it learned live here: back it up)')
    elif data.exists():
        bad(f'{data} is not writable'); problems += 1
    else:
        warn(f'data folder {data} does not exist yet (fix creates it)'); fixable.append('data')

    step('Git')
    if shutil.which('git') and (ROOT / '.git').exists():
        branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], capture=True).stdout.strip()
        dirty = sh(['git', 'status', '--porcelain'], capture=True).stdout.strip()
        ok(f'on branch {branch}')
        if dirty:
            warn(f'{len(dirty.splitlines())} uncommitted change(s): deploy keeps them, but commit what you want to keep')
    else:
        warn('not a git checkout: deploy can\'t pull updates')

    step('Server')
    h = local_health()
    if h:
        ok(f'running on port {port()}: version {h.get("version")}, storage persistent: {h.get("storage", {}).get("persistent")}')
        if h.get('version') != version:
            warn(f'running {h.get("version")} but the code is {version}: restart to pick it up')
    else:
        print(f'         not running on port {port()} (start it with: shotctl.py start)')

    print()
    fixable = sorted(set(fixable))
    if fixable:
        print(paint('33', f'{len(fixable)} thing(s) `shotctl.py fix` can do for you: {", ".join(fixable)}'))
    print(paint('31' if problems else '32', f'{problems} problem(s) found' if problems else 'No problems found'))
    return 1 if problems else 0


# ---------- fix ----------

def vapid_keys() -> tuple[str, str] | None:
    r = sh(['node', '-e', "import('./push.js').then(m=>{const k=m.generateVapidKeys();console.log(JSON.stringify(k))})"],
           capture=True, check=False)
    try:
        k = json.loads(r.stdout.strip().splitlines()[-1])
        return k['publicKey'], k['privateKey']
    except (ValueError, IndexError, KeyError):
        return None


def cmd_fix(args) -> int:
    dry = args.dry_run
    did = 0

    def act(msg: str) -> bool:
        nonlocal did
        did += 1
        print(f"  {paint('36', 'DRY ' if dry else 'FIX ')} {msg}")
        return not dry

    step('Fixing')
    if not deps_installed() and act('install dependencies (npm ci)'):
        sh(['npm', 'ci'] if (ROOT / 'package-lock.json').exists() else ['npm', 'install'])

    env = read_env()
    updates: dict[str, str | None] = {}
    if not env.get('ACCESS_SECRET') and act('generate ACCESS_SECRET (signs access passes)'):
        updates['ACCESS_SECRET'] = secrets.token_hex(32)
    if not env.get('KEY_SECRET') and act('generate KEY_SECRET (encrypts Kalshi keys the auto-trader holds)'):
        updates['KEY_SECRET'] = secrets.token_hex(32)
    if not (env.get('VAPID_PUBLIC_KEY') and env.get('VAPID_PRIVATE_KEY')) and act('generate and pin VAPID push keys'):
        keys = vapid_keys()
        if keys:
            updates['VAPID_PUBLIC_KEY'], updates['VAPID_PRIVATE_KEY'] = keys
        else:
            warn('could not generate VAPID keys (is Node 22+ installed?)')
    if not env.get('PORT') and act('set PORT=8080'):
        updates['PORT'] = '8080'
    if not env.get('DATA_DIR') and act(f'set DATA_DIR={ROOT / "data"}'):
        updates['DATA_DIR'] = str(ROOT / 'data')
    if updates:
        if not ENV_FILE.exists():
            ENV_FILE.write_text('# Shot Caller server settings (managed by scripts/shotctl.py). Never commit this file.\n')
        write_env(updates)
    if not WINDOWS and ENV_FILE.exists() and ENV_FILE.stat().st_mode & 0o077 and act('chmod 600 .env'):
        os.chmod(ENV_FILE, 0o600)

    data = Path(server_env()['DATA_DIR'])
    if not data.exists() and act(f'create data folder {data}'):
        data.mkdir(parents=True, exist_ok=True)

    if not did:
        ok('nothing to fix')
    elif dry:
        print('\nRun without --dry-run to apply.')
    else:
        print('\nDone. Run `shotctl.py scan` to check again' + (', then `shotctl.py restart` to load the new settings.' if local_health() else '.'))
    return 0


# ---------- env ----------

# never copied from another host: they belong to that host, or point at its old address
IMPORT_SKIP = re.compile(r'^(RAILWAY_|RENDER_)|^(PORT|DATA_DIR|APP_URL|DISCORD_REDIRECT_URI|MOVED_TO|NODE_VERSION)$')


def env_import(args) -> int:
    """Copy variables from another host's .env-style text (Railway: Variables -> Raw Editor), keeping what's set here."""
    src = args.pairs[0] if args.pairs else '-'
    text = sys.stdin.read() if src == '-' else Path(src).read_text()
    have = read_env()
    added, kept, skipped = [], [], []
    updates: dict[str, str | None] = {}
    lines = text.splitlines()
    if text.strip().startswith('{'):  # Railway's Raw Editor also offers JSON
        try:
            lines = [f'{k}={v}' for k, v in json.loads(text).items()]
        except (ValueError, AttributeError):
            die('that looks like JSON but isn\'t valid: copy the ENV tab of the Raw Editor instead')
    for line in lines:
        m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if not m or line.lstrip().startswith('#'):
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
            val = val[1:-1]
        if IMPORT_SKIP.search(key):
            skipped.append(key)
        elif have.get(key) and not args.overwrite:
            kept.append(key)
        else:
            updates[key] = val
            added.append(key)
    if not (added or kept or skipped):
        die('no KEY=VALUE lines found. In Railway: Variables -> Raw Editor, copy everything, paste it into the file, save it')
    if updates:
        write_env(updates)
    print(f'Imported: {", ".join(added) or "nothing new"}')
    if kept:
        print(f'Kept this computer\'s value for: {", ".join(kept)} (add --overwrite to take the imported ones)')
    if skipped:
        print(f'Skipped (they belong to the old host): {", ".join(skipped)}')
    print('Restart to load them: shotctl.py restart')
    return 0


def cmd_env(args) -> int:
    if args.action == 'import':
        return env_import(args)
    if args.action == 'list':
        env = read_env()
        if not env:
            print('No .env yet. Create one with: shotctl.py fix')
        for k, v in env.items():
            flag = '' if k in KNOWN_VARS | TOOL_VARS else paint('33', '  (not read by the server)')
            print(f'{k}={v if args.show else mask(k, v)}{flag}')
        return 0
    if args.action == 'set':
        updates: dict[str, str | None] = {}
        for pair in args.pairs:
            if '=' not in pair:
                die(f'expected KEY=VALUE, got {pair!r}')
            k, v = pair.split('=', 1)
            if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k):
                die(f'bad variable name {k!r}')
            if k not in KNOWN_VARS | TOOL_VARS:
                warn(f'{k} is not a variable the server reads (setting it anyway)')
            updates[k] = v
        write_env(updates)
    else:
        write_env({k: None for k in args.pairs})
    print(f'Updated .env ({", ".join(args.pairs if args.action == "unset" else [p.split("=", 1)[0] for p in args.pairs])}).')
    if local_health():
        print('The server is running: `shotctl.py restart` to apply.')
    return 0


# ---------- run / start / stop ----------

def local_health(timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port()}/healthz', timeout=timeout) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None


def wait_healthy(seconds: int) -> dict | None:
    end = time.time() + seconds
    while time.time() < end:
        h = local_health()
        if h:
            return h
        time.sleep(1)
    return None


def read_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text().strip())
        if WINDOWS:  # os.kill(pid, 0) would end the process on Windows, so ask tasklist instead
            out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True).stdout
            return pid if str(pid) in out else None
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def preflight() -> None:
    nv = node_version()
    if not nv or nv[0] < 22:
        die('Node 22+ is required (run: shotctl.py scan)')
    if not deps_installed():
        print('Installing dependencies...')
        sh(['npm', 'ci'] if (ROOT / 'package-lock.json').exists() else ['npm', 'install'])
    Path(server_env()['DATA_DIR']).mkdir(parents=True, exist_ok=True)


def cmd_run(args) -> int:
    """Foreground supervisor: restarts the server when it exits with an error, up to --max-restarts in a row."""
    preflight()
    restarts = 0
    child: subprocess.Popen | None = None

    def stop(signum, _frame):
        if child and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(10)
            except subprocess.TimeoutExpired:
                child.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        started = time.time()
        print(paint('1', f'shotctl: starting Shot Caller on http://localhost:{port()}'), flush=True)
        child = subprocess.Popen([shutil.which('node') or 'node', 'server.js'], cwd=ROOT, env=server_env())
        code = child.wait()
        if code == 0:
            print('shotctl: server exited cleanly'); return 0
        restarts = 0 if time.time() - started > 300 else restarts + 1  # a server that ran 5+ minutes starts the count over
        if restarts > args.max_restarts:
            print(f'shotctl: server crashed {restarts} times in a row, giving up', file=sys.stderr); return code
        delay = min(30, 2 ** restarts)
        print(f'shotctl: server exited with {code}, restarting in {delay}s ({restarts}/{args.max_restarts})', file=sys.stderr, flush=True)
        time.sleep(delay)


def detach() -> dict:
    """Popen options that keep the background server running after this terminal closes."""
    if WINDOWS:
        return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {'start_new_session': True}


def kill_tree(pid: int, force: bool) -> None:
    if WINDOWS:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
    else:
        os.killpg(pid, signal.SIGKILL if force else signal.SIGTERM)


def start_background(wait: int = 60) -> bool:
    if read_pid():
        if local_health(timeout=5):
            print(f'Already running (pid {read_pid()}).'); return True
        print(f'Process {read_pid()} is up but the server isn\'t answering: restarting it.')
        stop_background()
    preflight()
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_FILE, 'a')
    proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, **detach())
    PID_FILE.write_text(str(proc.pid))
    h = wait_healthy(wait)
    if h:
        print(f'Running: http://localhost:{port()}  (version {h.get("version")}, pid {proc.pid}, log {LOG_FILE})')
        return True
    print(f'Server did not answer /healthz within {wait}s. Last log lines:', file=sys.stderr)
    print('\n'.join(LOG_FILE.read_text().splitlines()[-20:]), file=sys.stderr)
    return False


def stop_background() -> None:
    pid = read_pid()
    if not pid:
        print('Not running.'); return
    kill_tree(pid, force=False)
    for _ in range(30):
        if not read_pid():
            break
        time.sleep(0.5)
    else:
        kill_tree(pid, force=True)
    PID_FILE.unlink(missing_ok=True)
    print('Stopped.')


def cmd_start(args) -> int: return 0 if start_background() else 1
def cmd_stop(args) -> int: stop_background(); return 0


def cmd_restart(args) -> int:
    stop_background()
    return 0 if start_background() else 1


def cmd_status(args) -> int:
    pid, h = read_pid(), local_health()
    print(f'pid:     {pid or "-"}')
    print(f'url:     http://localhost:{port()}')
    if h:
        print(json.dumps(h, indent=2))
        return 0
    print('health:  not answering')
    return 1


def cmd_logs(args) -> int:
    if not LOG_FILE.exists():
        print('No log yet.'); return 0
    print('\n'.join(LOG_FILE.read_text(errors='replace').splitlines()[-args.lines:]))
    if args.follow:  # like tail -f, and works on Windows too
        with open(LOG_FILE, errors='replace') as f:
            f.seek(0, os.SEEK_END)
            try:
                while True:
                    line = f.readline()
                    if line:
                        print(line, end='', flush=True)
                    else:
                        time.sleep(0.5)
            except KeyboardInterrupt:
                pass
    return 0


# ---------- deploy ----------

def cmd_deploy(args) -> int:
    """Railway-style deploy on this machine: pull, install, test, restart, health-check, roll back on failure."""
    git = (ROOT / '.git').exists() and shutil.which('git')
    before = sh(['git', 'rev-parse', 'HEAD'], capture=True).stdout.strip() if git else None
    if git and not args.no_pull:
        step('Pull')
        branch = args.branch or sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], capture=True).stdout.strip()
        sh(['git', 'fetch', 'origin', branch])
        r = sh(['git', 'merge', '--ff-only', f'origin/{branch}'], capture=True, check=False)
        print(r.stdout.strip())
        if r.returncode:
            die('could not fast-forward (local commits or changes in the way). Resolve them, then deploy again.')
    after = sh(['git', 'rev-parse', 'HEAD'], capture=True).stdout.strip() if git else None

    step('Install')
    lock_changed = git and before != after and sh(['git', 'diff', '--quiet', before, after, '--', 'package.json', 'package-lock.json'], check=False).returncode
    if lock_changed or not deps_installed():
        sh(['npm', 'ci'] if (ROOT / 'package-lock.json').exists() else ['npm', 'install'])
    else:
        ok('dependencies unchanged')

    if not args.skip_tests:
        step('Test')
        if sh(['npm', 'test', '--silent'], capture=True, check=False).returncode:
            if git and before != after:
                sh(['git', 'reset', '--hard', before])
                sh(['npm', 'ci'])
                print(f'Rolled the code back to {before[:7]}.')
            die('tests failed: the running server was left alone. Run `npm test` to see why.')
        ok('tests pass')

    step('Restart')
    stop_background()
    if start_background(args.health_timeout):
        print(paint('32', f'Deployed {after[:7] if after else "local code"}.'))
        return 0
    if git and before and before != after:
        print(paint('33', f'New version failed its health check: rolling back to {before[:7]}.'))
        stop_background()
        sh(['git', 'reset', '--hard', before])
        sh(['npm', 'ci'])
        start_background(args.health_timeout)
    return 1


# ---------- up: keep it all running, update itself, never lose data ----------

BACKUPS = '.backups'


def data_dir() -> Path:
    return Path(server_env()['DATA_DIR'])


def backup_data(keep: int = 10) -> Path | None:
    """Copy everything the app has saved (members, record, what it learned...) into DATA_DIR/.backups/<time>."""
    src = data_dir()
    if not src.is_dir():
        return None
    dest = src / BACKUPS / time.strftime('%Y%m%d-%H%M%S')
    n = 1
    while dest.exists():  # two backups in the same second
        dest, n = src / BACKUPS / f'{time.strftime("%Y%m%d-%H%M%S")}-{n}', n + 1
    shutil.copytree(src, dest, ignore=lambda d, names: [n for n in names if Path(d) == src and n in (BACKUPS, '.shotctl')])
    for old in sorted((src / BACKUPS).iterdir())[:-keep]:
        shutil.rmtree(old, ignore_errors=True)
    return dest


def cmd_backup(args) -> int:
    if args.restore:
        src = data_dir() / BACKUPS / args.restore
        if not src.is_dir():
            die(f'no backup {args.restore}. Backups: {", ".join(sorted(p.name for p in (data_dir() / BACKUPS).iterdir())) or "none"}')
        was_up = bool(local_health())
        stop_background()
        backup_data()  # the current data too, in case this was a mistake
        for item in data_dir().iterdir():  # the data becomes exactly the backup (the backups and this tool's files stay)
            if item.name not in (BACKUPS, '.shotctl'):
                shutil.rmtree(item) if item.is_dir() else item.unlink()
        for item in src.iterdir():
            (shutil.copytree if item.is_dir() else shutil.copy2)(item, data_dir() / item.name)
        print(f'Restored {args.restore}.')
        return 0 if not was_up or start_background() else 1
    dest = backup_data(args.keep)
    print(f'Backed up to {dest}' if dest else 'Nothing to back up yet.')
    return 0


def find_cloudflared() -> str | None:
    found = shutil.which('cloudflared')
    if found or not WINDOWS:
        return found
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles')):  # a fresh install isn't on PATH yet
        exe = Path(base or '') / 'cloudflared' / 'cloudflared.exe'
        if base and exe.exists():
            return str(exe)
    return None


def behind_by(branch: str) -> int:
    if sh(['git', 'fetch', '-q', 'origin', branch], capture=True, check=False).returncode:
        return 0  # offline for a moment: try again next time
    r = sh(['git', 'rev-list', '--count', f'HEAD..origin/{branch}'], capture=True, check=False)
    return int(r.stdout.strip() or 0) if r.returncode == 0 else 0


def cmd_up(args) -> int:
    """Run the app (and the tunnel) and keep them up. Restarts only for a crash or an update; data is backed up first."""
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    log_file = open(RUN_DIR / 'up.log', 'a', encoding='utf-8')

    def say(msg: str) -> None:
        line = f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {msg}'
        print(line, flush=True)
        log_file.write(line + '\n'); log_file.flush()

    git = (ROOT / '.git').exists() and shutil.which('git')
    branch = args.branch or (sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], capture=True).stdout.strip() if git else None)
    token = read_env().get('TUNNEL_TOKEN') or os.environ.get('TUNNEL_TOKEN')
    exe = find_cloudflared() if token else None
    if token and not exe:
        say('TUNNEL_TOKEN is set but cloudflared is not installed: running without the tunnel')
    say(f'Shot Caller up: app on http://localhost:{port()}' + (', tunnel on' if exe else ', no tunnel (set TUNNEL_TOKEN to run it here)')
        + (f', checking {branch} for updates every ' + (f'{args.check_every // 60} min' if args.check_every >= 60 else f'{args.check_every}s') if git and not args.no_update else ''))

    if not local_health() and not start_background(args.health_timeout):
        say('the app did not start: see `shotctl.py logs`')
    tunnel: subprocess.Popen | None = None
    tunnel_log = open(RUN_DIR / 'tunnel.log', 'a', encoding='utf-8') if exe else None
    misses, next_check, last_failed = 0, 0.0, None
    try:
        while True:
            if exe and (tunnel is None or tunnel.poll() is not None):
                if tunnel is not None:
                    say(f'the tunnel stopped (exit {tunnel.returncode}): starting it again')
                # the token goes in through the environment, never on the command line
                tunnel = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', 'run'], cwd=ROOT, env={**os.environ, 'TUNNEL_TOKEN': token},
                                          stdout=tunnel_log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            if local_health(timeout=5):
                misses = 0
            else:
                misses += 1
                if misses >= 3:  # down for ~90 seconds, not just a busy moment
                    say('the app is not answering: restarting it (data is kept)')
                    stop_background()
                    start_background(args.health_timeout)
                    misses = 0
            if git and not args.no_update and time.time() >= next_check:
                next_check = time.time() + args.check_every
                if behind_by(branch):
                    remote = sh(['git', 'rev-parse', f'origin/{branch}'], capture=True).stdout.strip()
                    if remote != last_failed:
                        say(f'update found ({remote[:7]}): backing up the data, then installing')
                        dest = backup_data()
                        if dest:
                            say(f'data backed up to {dest}')
                        try:
                            code = cmd_deploy(argparse.Namespace(branch=branch, no_pull=False, skip_tests=args.skip_tests, health_timeout=args.health_timeout))
                        except SystemExit as e:
                            code = e.code or 1
                        if code:
                            last_failed = remote  # don't retry the same broken version every 5 minutes
                            say(f'update {remote[:7]} was not installed (tests or health check failed); still running the old version')
                        else:
                            say(f'updated to {remote[:7]}; all data kept')
            time.sleep(30)
    except KeyboardInterrupt:
        say('stopping the tunnel (the app keeps running; `shotctl.py stop` stops it)')
        return 0
    finally:
        if tunnel and tunnel.poll() is None:
            tunnel.terminate()


def cmd_install_startup(args) -> int:
    """Start `up` when you log in (Windows Startup folder; no admin needed)."""
    if not WINDOWS:
        print('On Linux use install-service (systemd); on a Mac, add `shotctl.py up` to Login Items.')
        return 1
    folder = Path(os.environ['APPDATA']) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup'
    target = folder / 'Shot Caller.cmd'
    if args.remove:
        target.unlink(missing_ok=True)
        print('Removed: Shot Caller no longer starts when you log in.')
        return 0
    target.write_text(f'@echo off\r\ncd /d "{ROOT}"\r\nstart "Shot Caller" /min "{sys.executable}" "{Path(__file__).resolve()}" up\r\n')
    print(f'Shot Caller now starts when you log in (minimized window "Shot Caller").\n  {target}\nRemove it with: shotctl.py install-startup --remove')
    return 0


# ---------- going public ----------

def cmd_tunnel(args) -> int:
    """A free public https:// address through a Cloudflare quick tunnel."""
    exe = find_cloudflared()
    if not exe:
        print('cloudflared is not installed. Install it, then close and reopen this window:\n'
              '  Windows: winget install --id Cloudflare.cloudflared\n'
              '  macOS:   brew install cloudflared\n'
              '  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
        return 1
    if not local_health() and not start_background():
        return 1
    print('Opening a tunnel. The https://….trycloudflare.com address below is your public app and website.')
    print('Put it in APP_URL (shotctl.py env set APP_URL=...) and restart so links and Discord use it.')
    print('The address changes each time; for a permanent one use a named tunnel or install-service with a domain.\n')
    return subprocess.call([exe, 'tunnel', '--no-autoupdate', '--url', f'http://localhost:{port()}'])


def cmd_install_service(args) -> int:
    user = args.user or getpass.getuser()
    out = RUN_DIR
    out.mkdir(parents=True, exist_ok=True)
    unit = f"""[Unit]
Description=Shot Caller
After=network-online.target
Wants=network-online.target

[Service]
User={user}
WorkingDirectory={ROOT}
ExecStart={sys.executable} {Path(__file__).resolve()} run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""
    (out / 'shot-caller.service').write_text(unit)
    files = [out / 'shot-caller.service']
    if args.domain:
        caddy = f"""{args.domain} {{
\tencode zstd gzip
\treverse_proxy 127.0.0.1:{port()}
}}
"""
        (out / 'Caddyfile').write_text(caddy)
        files.append(out / 'Caddyfile')
        write_env({'APP_URL': f'https://{args.domain}'})
    print('Wrote:')
    for f in files:
        print(f'  {f}')
    print(f"""
Install it (Linux server with systemd):
  sudo cp {out / 'shot-caller.service'} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now shot-caller
  journalctl -u shot-caller -f          # logs""")
    if args.domain:
        print(f"""
HTTPS for {args.domain} (Caddy gets and renews the certificate on its own):
  1. Point an A record for {args.domain} at this server's public IP, and open ports 80 and 443.
  2. Install Caddy (https://caddyserver.com/docs/install), then:
     sudo cp {out / 'Caddyfile'} /etc/caddy/Caddyfile && sudo systemctl reload caddy
  3. Open https://{args.domain} : the website, and the installable phone app after signing in.
APP_URL is now https://{args.domain} in .env.""")
    print('\nUpdates later: shotctl.py deploy  (with the service installed, run `sudo systemctl restart shot-caller` instead of the restart step).')
    return 0


# ---------- live ----------

def load_conf() -> dict:
    try:
        return json.loads(CONF_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_conf(conf: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    CONF_FILE.write_text(json.dumps(conf, indent=2))


def live_base(args) -> str:
    url = getattr(args, 'url', None) or os.environ.get('SHOTCALLER_URL') or load_conf().get('url') or f'http://localhost:{port()}'
    return url.rstrip('/')


def cookie_file(base: str) -> Path:
    # one sign-in per address: cookies don't tell ports apart, so two servers on localhost would share one
    return STATE_DIR / f'cookies-{re.sub(r"[^A-Za-z0-9.-]+", "_", base.split("://", 1)[-1])}.txt'


def opener(base: str) -> tuple[urllib.request.OpenerDirector, http.cookiejar.MozillaCookieJar]:
    jar = http.cookiejar.MozillaCookieJar(str(cookie_file(base)))
    if cookie_file(base).exists():
        jar.load(ignore_discard=True, ignore_expires=True)
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def call(args, method: str, path: str, body: dict | None = None, base: str | None = None) -> dict:
    base = base or live_base(args)
    op, jar = opener(base)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'content-type': 'application/json', 'user-agent': 'shotctl'})
    try:
        with op.open(req, timeout=60) as r:
            out = json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get('error')
        except ValueError:
            msg = None
        if e.code == 403 and path.startswith('/api/admin/'):
            die(f'{msg or "admin only"}: sign in first with `shotctl.py live login --url {base}`')
        die(f'{method} {path}: HTTP {e.code} {msg or e.reason}')
    except urllib.error.URLError as e:
        die(f'could not reach {base}: {e.reason}')
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    jar.save(ignore_discard=True, ignore_expires=True)
    os.chmod(cookie_file(base), 0o600)
    return out


def show(obj) -> None:
    print(json.dumps(obj, indent=2))


def cmd_live(args) -> int:
    a = args.live_action
    if a == 'health':
        show(call(args, 'GET', '/healthz'))
    elif a == 'record':
        show(call(args, 'GET', '/api/public/record'))
    elif a == 'login':
        code = args.code or os.environ.get('SHOTCALLER_ADMIN_CODE') or getpass.getpass('Admin code: ')
        out = call(args, 'POST', '/api/access/admin', {'code': code, 'device': 'shotctl'})
        conf = load_conf()
        conf['url'] = live_base(args)
        save_conf(conf)
        print(f'Signed in to {conf["url"]} as admin (role: {out.get("role", "admin")}). The live commands use this address from now on.')
    elif a == 'logout':
        call(args, 'POST', '/api/access/logout', {})
        cookie_file(live_base(args)).unlink(missing_ok=True)
        print('Signed out.')
    elif a == 'members':
        out = call(args, 'GET', '/api/admin/members')
        cfg = out.get('config', {})
        print(f'Price ${cfg.get("price")} for {cfg.get("days")} days · Cash App ${cfg.get("cashtag")}\n')
        rows = out.get('members', [])
        if args.status:
            rows = [m for m in rows if m.get('status') == args.status]
        print(f'{"CODE":<10}{"STATUS":<10}{"PAID":<6}{"EXPIRES":<18}DEVICES')
        for m in rows:
            exp = time.strftime('%Y-%m-%d %H:%M', time.localtime(m['expires'] / 1000)) if m.get('expires') else '-'
            print(f'{m["code"]:<10}{m["status"]:<10}{"yes" if m.get("paidAt") else "no":<6}{exp:<18}{m.get("devices", 0)}')
        print(f'\n{len(rows)} member(s)')
    elif a in ('approve', 'deny', 'revoke'):
        if a == 'approve' and args.code.lower() == 'new':  # same alphabet as access.js newCode (no 0/O, 1/I/L)
            args.code = 'SC-' + ''.join(secrets.choice('ABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(6))
        body = {'code': args.code}
        if a == 'approve' and args.until:
            # the server adds days to now, so turn the date into days left until 11:59 pm that day (local time)
            try:
                end = time.mktime(time.strptime(args.until + ' 23:59', '%Y-%m-%d %H:%M'))
            except ValueError:
                die(f'--until takes a date like 2026-11-15, not {args.until!r}')
            if end <= time.time():
                die(f'{args.until} has already passed')
            body['days'] = (end - time.time()) / 86400
        elif a == 'approve' and args.days:
            body['days'] = args.days
        m = call(args, 'POST', f'/api/admin/{a}', body).get('member', {})
        exp = time.strftime('%Y-%m-%d %H:%M', time.localtime(m['expires'] / 1000)) if m.get('expires') else '-'
        print(f'{m.get("code", args.code)}: {m.get("status")} (expires {exp})')
    elif a == 'config':
        if args.price is None and args.days is None:
            show(call(args, 'GET', '/api/admin/members').get('config'))
        else:
            show(call(args, 'POST', '/api/admin/config', {k: v for k, v in (('price', args.price), ('days', args.days)) if v is not None}))
    elif a == 'tuneup':
        show(call(args, 'POST' if args.run else 'GET', '/api/admin/tuneup', {} if args.run else None))
    elif a == 'migrate':
        old = args.old.rstrip('/')
        if old == live_base(args):
            die('--from is the same address as this server')
        call(args, 'GET', '/api/admin/members')  # signed in here? (stops with how to sign in if not)
        code = os.environ.get('SHOTCALLER_OLD_ADMIN_CODE') or getpass.getpass(f'Admin code for the OLD site {old}: ')
        call(args, 'POST', '/api/access/admin', {'code': code, 'device': 'shotctl'}, base=old)
        theirs = call(args, 'GET', '/api/admin/members', base=old)
        cfg = theirs.get('config', {})
        if cfg.get('price') or cfg.get('days'):
            call(args, 'POST', '/api/admin/config', {'price': cfg.get('price'), 'days': cfg.get('days')})
            print(f'Price ${cfg.get("price")} for {cfg.get("days")} days copied.')
        now_ms = time.time() * 1000
        moved = waiting = 0
        for m in theirs.get('members', []):
            if m.get('status') == 'active' and m.get('expires', 0) > now_ms:
                call(args, 'POST', '/api/admin/approve', {'code': m['code'], 'days': (m['expires'] - now_ms) / 86400000})
                print(f'  {m["code"]}  active until {time.strftime("%Y-%m-%d %H:%M", time.localtime(m["expires"] / 1000))}')
                moved += 1
            elif m.get('status') == 'pending' and m.get('paidAt'):
                print(f'  {m["code"]}  says they paid, not approved yet: approve it here once you\'ve checked Cash App')
                waiting += 1
        print(f'{moved} active member(s) copied to {live_base(args)}' + (f', {waiting} waiting for approval' if waiting else '') + '.')
        print('They sign in on the new site with the same code ("Already paid on another device? Enter your code").')
    elif a == 'hiring':
        if args.decide:
            show(call(args, 'POST', '/api/admin/hiring', {'id': args.decide[0], 'decision': args.decide[1]}))
        else:
            show(call(args, 'GET', '/api/admin/hiring'))
    return 0


# ---------- cli ----------

def main() -> int:
    p = argparse.ArgumentParser(prog='shotctl.py', description=__doc__.split('\n\n')[0],
                                epilog='Run `shotctl.py <command> -h` for a command\'s options.', formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True, metavar='command')

    s = sub.add_parser('scan', help='check the code, tests, settings and the running server')
    s.add_argument('--no-tests', action='store_true', help='skip npm test')
    s.add_argument('--test-timeout', type=int, default=900)
    s.set_defaults(fn=cmd_scan)

    s = sub.add_parser('fix', help='apply the safe fixes scan finds')
    s.add_argument('--dry-run', action='store_true', help='show what it would do')
    s.set_defaults(fn=cmd_fix)

    s = sub.add_parser('env', help='list / set / unset server variables in .env')
    s.add_argument('action', choices=['list', 'set', 'unset', 'import'], nargs='?', default='list')
    s.add_argument('pairs', nargs='*', help='KEY=VALUE for set, KEY for unset, a file (or - for pasted text) for import')
    s.add_argument('--overwrite', action='store_true', help='import: replace values already set here')
    s.add_argument('--show', action='store_true', help='show secret values in full')
    s.set_defaults(fn=cmd_env)

    s = sub.add_parser('run', help='run the server in the foreground, restarting on crashes')
    s.add_argument('--max-restarts', type=int, default=10)
    s.set_defaults(fn=cmd_run)
    sub.add_parser('start', help='start the server in the background').set_defaults(fn=cmd_start)
    sub.add_parser('stop', help='stop the background server').set_defaults(fn=cmd_stop)
    sub.add_parser('restart', help='restart the background server (loads .env changes)').set_defaults(fn=cmd_restart)
    sub.add_parser('status', help='is it running, and its /healthz').set_defaults(fn=cmd_status)
    s = sub.add_parser('logs', help='the background server\'s log')
    s.add_argument('-n', '--lines', type=int, default=50)
    s.add_argument('-f', '--follow', action='store_true')
    s.set_defaults(fn=cmd_logs)

    s = sub.add_parser('deploy', help='pull, install, test, restart, roll back on failure')
    s.add_argument('--branch', help='branch to pull (default: the current one)')
    s.add_argument('--no-pull', action='store_true', help='deploy the code as it is on disk')
    s.add_argument('--skip-tests', action='store_true')
    s.add_argument('--health-timeout', type=int, default=90)
    s.set_defaults(fn=cmd_deploy)

    s = sub.add_parser('up', help='run the app and tunnel, keep them up, install updates (data backed up first)')
    s.add_argument('--check-every', type=int, default=300, help='seconds between update checks (default 300)')
    s.add_argument('--branch', help='branch to follow (default: the current one)')
    s.add_argument('--no-update', action='store_true', help='never install updates')
    s.add_argument('--skip-tests', action='store_true', help='install updates without running the tests first')
    s.add_argument('--health-timeout', type=int, default=90)
    s.set_defaults(fn=cmd_up)
    s = sub.add_parser('install-startup', help='start `up` when you log in to Windows')
    s.add_argument('--remove', action='store_true')
    s.set_defaults(fn=cmd_install_startup)
    s = sub.add_parser('backup', help='copy all saved data to data/.backups (or --restore one)')
    s.add_argument('--keep', type=int, default=10)
    s.add_argument('--restore', metavar='NAME', help='a backup folder name, e.g. 20261021-153000')
    s.set_defaults(fn=cmd_backup)
    sub.add_parser('tunnel', help='public https address through Cloudflare (no domain needed)').set_defaults(fn=cmd_tunnel)
    s = sub.add_parser('install-service', help='write a systemd unit, and a Caddyfile for HTTPS on your domain')
    s.add_argument('--domain', help='e.g. shotcaller.example.com')
    s.add_argument('--user', help='user the service runs as (default: you)')
    s.set_defaults(fn=cmd_install_service)

    # --url works before or after the action (live --url X login, or live login --url X)
    url_opt = argparse.ArgumentParser(add_help=False)
    url_opt.add_argument('--url', default=argparse.SUPPRESS, help='app address (default: the one you logged in to, else localhost)')
    s = sub.add_parser('live', help='talk to a running app (local or hosted)', parents=[url_opt])
    ls = s.add_subparsers(dest='live_action', required=True, metavar='action')
    ls.add_parser('health', parents=[url_opt])
    ls.add_parser('record', parents=[url_opt])
    x = ls.add_parser('login', parents=[url_opt]); x.add_argument('--code', help='admin code (default: prompt, or SHOTCALLER_ADMIN_CODE)')
    ls.add_parser('logout', parents=[url_opt])
    x = ls.add_parser('members', parents=[url_opt]); x.add_argument('--status', choices=['pending', 'active', 'denied', 'revoked'])
    x = ls.add_parser('approve', parents=[url_opt]); x.add_argument('code', help='a code like SC-ABC234, or "new" to make one up')
    g = x.add_mutually_exclusive_group(); g.add_argument('--days', type=float); g.add_argument('--until', metavar='YYYY-MM-DD', help='access ends at 11:59 pm that day')
    x = ls.add_parser('deny', parents=[url_opt]); x.add_argument('code')
    x = ls.add_parser('revoke', parents=[url_opt]); x.add_argument('code')
    x = ls.add_parser('config', parents=[url_opt]); x.add_argument('--price', type=float); x.add_argument('--days', type=int)
    x = ls.add_parser('tuneup', parents=[url_opt]); x.add_argument('--run', action='store_true', help='run it now instead of showing the last report')
    x = ls.add_parser('migrate', parents=[url_opt], help='copy active members (and the price) from the old site')
    x.add_argument('--from', dest='old', required=True, metavar='URL', help='the old site, e.g. https://shot-caller.up.railway.app')
    x = ls.add_parser('hiring', parents=[url_opt]); x.add_argument('--decide', nargs=2, metavar=('ID', 'DECISION'), help='DECISION is approve, decline, or fire (let a hire go; ID is then its key)')
    s.set_defaults(fn=cmd_live)

    for stream in (sys.stdout, sys.stderr):  # a Windows console can't print every character; never crash over one
        try:
            stream.reconfigure(errors='replace')
        except AttributeError:
            pass
    args = p.parse_args()
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
