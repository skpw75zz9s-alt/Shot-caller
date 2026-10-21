#!/usr/bin/env python3
"""bugwatch: never stops looking for problems with Shot Caller, and fixes the ones it safely can.

Runs next to `shotctl.py up` (Python 3.9+, standard library only). Every minute it checks, and fixes:

  the app        not answering for 5 minutes (a backstop: `up` restarts it after 90 s)  -> restart it
  the website    APP_URL unreachable while the app is fine (a stuck tunnel)            -> restart the tunnel
  Kalshi         blocked or unreachable                                               -> reconnect Cloudflare WARP
  the bot        no tick for 5 minutes although Kalshi answers                        -> restart the app
  saved data     a data file that no longer reads as JSON                             -> restore it from the newest good backup
  disk           logs over 20 MB                                                      -> rotate them
                 under 1 GB free                                                      -> keep only the 3 newest backups
  errors         new errors and stack traces in the server's log                      -> grouped in the report
  tests          the test suite, after every code change and every 12 hours           -> failures in the report

What it can't fix (a failing test, an error that keeps coming back) goes in the report, and to Discord when
BUGWATCH_WEBHOOK is set to a webhook of a private channel. Code bugs are fixed upstream and arrive through
`shotctl.py up`'s auto-update. The report: data/.shotctl/bugwatch.md. The log: data/.shotctl/bugwatch.log.

  python3 scripts/bugwatch.py                     run it (Ctrl+C stops it)
  python3 scripts/bugwatch.py --once              one round of checks, then exit
  python3 scripts/bugwatch.py --install-startup   start it when you log in to Windows (--remove-startup to undo)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shotctl  # noqa: E402  (same folder: its settings, health check and server control)

RUN_DIR = shotctl.RUN_DIR
LOG = RUN_DIR / 'bugwatch.log'
REPORT = RUN_DIR / 'bugwatch.md'
STATE = RUN_DIR / 'bugwatch.json'
SERVER_LOG = shotctl.LOG_FILE
ERROR_LINE = re.compile(r'\b(Error|Exception|Unhandled|uncaught|failed|FATAL)\b|^\s+at\s', re.I)
NOISE = re.compile(r'Admin bypass|Generated new VAPID|npm notice')  # startup notes, not bugs
MAX_LOG = 20 * 1024 * 1024
RESTART_GAP = 30 * 60  # the watcher restarts the app at most once per 30 minutes


def stamp() -> str:
    return time.strftime('%Y-%m-%d %H:%M:%S')


class Watch:
    def __init__(self, args):
        self.args = args
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        try:
            self.state = json.loads(STATE.read_text())
        except (OSError, ValueError):
            self.state = {}
        self.state.setdefault('errors', {})  # signature -> {n, first, last, sample}
        self.state.setdefault('fixes', [])   # newest last
        self.state.setdefault('log_pos', 0)
        self.misses = {'app': 0, 'site': 0, 'kalshi': 0, 'bot': 0}
        self.status: dict[str, str] = {}
        self.last_restart = 0.0
        self.next_tests = 0.0
        self.tested_head = self.state.get('tested_head')
        self.alerted: dict[str, float] = {}

    # ---------- output ----------
    def say(self, msg: str) -> None:
        line = f'{stamp()}  {msg}'
        print(line, flush=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')

    def fixed(self, what: str) -> None:
        self.say(f'FIXED  {what}')
        self.state['fixes'] = (self.state['fixes'] + [f'{stamp()}  {what}'])[-50:]

    def alert(self, key: str, msg: str) -> None:
        """A problem it couldn't fix: logged, and sent to Discord at most every 6 hours per problem."""
        self.say(f'NEEDS YOU  {msg}')
        hook = shotctl.read_env().get('BUGWATCH_WEBHOOK') or os.environ.get('BUGWATCH_WEBHOOK')
        if not hook or time.time() - self.alerted.get(key, 0) < 6 * 3600:
            return
        self.alerted[key] = time.time()
        body = json.dumps({'username': 'Shot Caller bug watch', 'content': f'⚠️ {msg}'[:1900]}).encode()
        try:
            urllib.request.urlopen(urllib.request.Request(hook, data=body, headers={'content-type': 'application/json', 'user-agent': 'bugwatch'}), timeout=10)
        except (OSError, ValueError):
            pass

    def save(self) -> None:
        STATE.write_text(json.dumps(self.state))
        errs = sorted(self.state['errors'].items(), key=lambda kv: -kv[1]['last'])[:20]
        lines = [f'# Shot Caller bug watch', '', f'Updated {stamp()}', '', '## Now', '']
        lines += [f'- **{k}**: {v}' for k, v in self.status.items()]
        lines += ['', '## Errors in the server log (newest first)', '']
        lines += [f'- {v["n"]}× `{sig}` (last {time.strftime("%m-%d %H:%M", time.localtime(v["last"]))})\n  `{v["sample"][:300]}`' for sig, v in errs] or ['- none']
        lines += ['', '## What it fixed', ''] + ([f'- {f}' for f in reversed(self.state['fixes'][-20:])] or ['- nothing yet'])
        REPORT.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    # ---------- fixes ----------
    def restart_app(self, why: str) -> None:
        if time.time() - self.last_restart < RESTART_GAP:
            self.say(f'would restart the app ({why}) but did so less than 30 minutes ago: waiting')
            return
        self.last_restart = time.time()
        shotctl.stop_background()
        if shotctl.start_background(90):
            self.fixed(f'restarted the app: {why}')
        else:
            self.alert('app-start', f'the app does not start ({why}). Run `py scripts\\shotctl.py logs` to see why.')

    def restart_tunnel(self) -> None:
        if not shotctl.read_env().get('TUNNEL_TOKEN'):
            return self.alert('tunnel', 'the website is unreachable but the app is fine: is the tunnel window running?')
        # `up` runs the tunnel and starts it again as soon as it exits
        cmd = ['taskkill', '/IM', 'cloudflared.exe', '/F'] if shotctl.WINDOWS else ['pkill', '-f', 'cloudflared tunnel']
        subprocess.run(cmd, capture_output=True)
        self.fixed('restarted the stuck tunnel (shotctl up brings it back within 30 seconds)')

    def reconnect_warp(self) -> bool:
        exe = shutil.which('warp-cli')
        if not exe and shotctl.WINDOWS:
            for base in (os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)')):
                cand = Path(base or '') / 'Cloudflare' / 'Cloudflare WARP' / 'warp-cli.exe'
                if base and cand.exists():
                    exe = str(cand)
        if not exe:
            return False
        r = subprocess.run([exe, 'connect'], capture_output=True, text=True)
        if r.returncode == 0:
            self.fixed('reconnected Cloudflare WARP (Kalshi was blocked)')
            return True
        return False

    # ---------- checks ----------
    def check_app(self) -> dict | None:
        h = shotctl.local_health(timeout=5)
        if h:
            self.misses['app'] = 0
            self.status['App'] = f'running, version {h.get("version")}'
            return h
        self.misses['app'] += 1
        self.status['App'] = f'not answering ({self.misses["app"]} min)'
        if self.misses['app'] >= 5:
            self.restart_app('it stopped answering')
            self.misses['app'] = 0
        return None

    def check_site(self, app_ok: bool) -> None:
        url = shotctl.read_env().get('APP_URL')
        if not url:
            self.status['Website'] = 'APP_URL not set: not checked'
            return
        try:
            with urllib.request.urlopen(urllib.request.Request(url.rstrip('/') + '/healthz', headers={'user-agent': 'bugwatch'}), timeout=15) as r:
                r.read()
            self.misses['site'] = 0
            self.status['Website'] = f'{url} is up'
        except (OSError, ValueError) as e:
            self.misses['site'] += 1
            self.status['Website'] = f'{url} unreachable: {getattr(e, "code", "") or getattr(e, "reason", e)}'
            if app_ok and self.misses['site'] == 3:
                self.restart_tunnel()
            elif app_ok and self.misses['site'] == 10:
                self.alert('site', f'{url} has been unreachable for 10 minutes although the app runs. Check the tunnel in Cloudflare.')

    def check_kalshi(self) -> bool:
        try:
            with urllib.request.urlopen(urllib.request.Request('https://api.elections.kalshi.com/trade-api/v2/exchange/status', headers={'user-agent': 'bugwatch'}), timeout=15) as r:
                r.read()
            self.misses['kalshi'] = 0
            self.status['Kalshi'] = 'reachable'
            return True
        except urllib.error.HTTPError as e:  # Kalshi answered, so the connection works
            self.misses['kalshi'] = 0
            self.status['Kalshi'] = f'answering (HTTP {e.code})'
            return True
        except (OSError, ValueError) as e:
            self.misses['kalshi'] += 1
            self.status['Kalshi'] = f'unreachable: {getattr(e, "reason", e)}'
            if self.misses['kalshi'] == 2 and not self.reconnect_warp():
                self.alert('kalshi', 'this computer cannot reach Kalshi, so the bot has no prices. Turn on Cloudflare WARP.')
            return False

    def check_bot(self, h: dict, kalshi_ok: bool) -> None:
        bot = h.get('bot') or {}
        tick, err = bot.get('lastTick'), bot.get('lastError')
        age = (time.time() * 1000 - tick) / 60000 if isinstance(tick, (int, float)) else None
        self.status['Bot'] = (f'last tick {age:.0f} min ago' if age is not None else 'no tick yet') + (f', last error: {err}' if err else '')
        stale = age is not None and age > 5  # it was ticking and stopped (a bot that never started is reported, not restarted)
        if age is None and kalshi_ok and (shotctl.read_pid() or 0) and self.misses['app'] == 0:
            self.status['Bot'] += ' (it starts when Kalshi answers and a phone subscribes or learning is on)'
        if stale and kalshi_ok:
            self.misses['bot'] += 1
            if self.misses['bot'] >= 5:
                self.restart_app('the bot stopped ticking although Kalshi answers')
                self.misses['bot'] = 0
        else:
            self.misses['bot'] = 0

    def check_server_log(self) -> None:
        if not SERVER_LOG.exists():
            return
        size = SERVER_LOG.stat().st_size
        pos = self.state['log_pos'] if self.state['log_pos'] <= size else 0  # the log was rotated
        with open(SERVER_LOG, encoding='utf-8', errors='replace') as f:
            f.seek(pos)
            lines = f.read().splitlines()
            self.state['log_pos'] = f.tell()
        for i, line in enumerate(lines):
            if not ERROR_LINE.search(line) or NOISE.search(line) or line.lstrip().startswith('at '):
                continue
            sig = re.sub(r'\d+', 'N', re.sub(r'https?://\S+', 'URL', line.strip()))[:160]  # the same error with other numbers is one error
            e = self.state['errors'].setdefault(sig, {'n': 0, 'first': time.time(), 'sample': ''})
            e['n'] += 1
            e['last'] = time.time()
            trace = [l for l in lines[i + 1:i + 4] if l.lstrip().startswith('at ')]
            e['sample'] = '\n'.join([line, *trace])  # the line and the start of its stack trace
            if e['n'] in (1, 50, 500):
                self.say(f'error in the server log ({e["n"]}×): {line.strip()[:200]}')
        if len(self.state['errors']) > 200:  # keep the most recent
            self.state['errors'] = dict(sorted(self.state['errors'].items(), key=lambda kv: -kv[1]['last'])[:200])
        self.status['Server log'] = f'{len(self.state["errors"])} kinds of error seen'

    def check_data(self) -> None:
        data = shotctl.data_dir()
        if not data.is_dir():
            return
        bad = []
        for f in data.rglob('*.json'):
            rel = f.relative_to(data)
            if rel.parts[0] in (shotctl.BACKUPS, '.shotctl') or time.time() - f.stat().st_mtime < 10:
                continue  # backups, this tool's files, and a file being written right now
            try:
                json.loads(f.read_text(encoding='utf-8'))
            except (ValueError, UnicodeDecodeError):
                bad.append(rel)
            except OSError:
                pass
        if not bad:
            self.status['Saved data'] = 'all files read fine'
            return
        backups = sorted((data / shotctl.BACKUPS).iterdir(), reverse=True) if (data / shotctl.BACKUPS).is_dir() else []
        shotctl.stop_background()  # the app would write its broken copy back over the repair
        for rel in bad:
            for b in backups:
                try:
                    good = (b / rel).read_text(encoding='utf-8')
                    json.loads(good)
                except (OSError, ValueError, UnicodeDecodeError):
                    continue
                shutil.copy2(data / rel, data / f'{rel}.broken-{time.strftime("%Y%m%d%H%M%S")}')
                (data / rel).write_text(good, encoding='utf-8')
                self.fixed(f'{rel} was damaged: restored it from backup {b.name} (the damaged copy is kept next to it)')
                break
            else:
                self.alert(f'data-{rel}', f'{rel} is damaged and no backup has a good copy.')
        shotctl.start_background(90)
        self.status['Saved data'] = f'repaired {len(bad)} file(s)'

    def check_disk(self) -> None:
        for f in RUN_DIR.glob('*.log'):
            if f.stat().st_size > MAX_LOG:
                old = f.with_suffix('.log.1')
                old.unlink(missing_ok=True)
                try:
                    shutil.copy2(f, old)
                    with open(f, 'w'):  # truncate in place: the app keeps writing to the same file
                        pass
                    if f == SERVER_LOG:
                        self.state['log_pos'] = 0
                    self.fixed(f'{f.name} passed 20 MB: kept the last part as {old.name} and started it fresh')
                except OSError:
                    pass
        free = shutil.disk_usage(shotctl.ROOT).free
        self.status['Disk'] = f'{free / 1e9:.1f} GB free'
        if free < 1e9:
            backups = sorted((shotctl.data_dir() / shotctl.BACKUPS).iterdir()) if (shotctl.data_dir() / shotctl.BACKUPS).is_dir() else []
            for b in backups[:-3]:
                shutil.rmtree(b, ignore_errors=True)
            if len(backups) > 3:
                self.fixed(f'disk almost full: removed {len(backups) - 3} old backups (kept the 3 newest)')
            if shutil.disk_usage(shotctl.ROOT).free < 5e8:
                self.alert('disk', f'the disk is almost full ({free / 1e9:.1f} GB free). Free up space on this computer.')

    def run_tests(self) -> None:
        head = shotctl.sh(['git', 'rev-parse', 'HEAD'], capture=True, check=False).stdout.strip() if (shotctl.ROOT / '.git').exists() else 'local'
        if head == self.tested_head and time.time() < self.next_tests:
            return
        self.next_tests = time.time() + 12 * 3600
        self.say(f'running the tests on {head[:7]} (the live app and its data aren\'t touched)')
        r = shotctl.sh(['npm', 'test', '--silent'], capture=True, check=False, timeout=1800)
        failing = [l.strip() for l in r.stdout.splitlines() if re.match(r'^\s*not ok ', l)]
        self.tested_head = self.state['tested_head'] = head
        if r.returncode == 0:
            self.status['Tests'] = f'all pass on {head[:7]} ({stamp()})'
        else:
            self.status['Tests'] = f'{len(failing) or "some"} failing on {head[:7]}: ' + '; '.join(failing[:5])
            self.alert(f'tests-{head}', f'tests fail on {head[:7]}: ' + '; '.join(failing[:5]))

    # ---------- the loop ----------
    def round(self) -> None:
        h = self.check_app()
        self.check_site(app_ok=h is not None)
        kalshi_ok = self.check_kalshi()
        if h:
            self.check_bot(h, kalshi_ok)
        self.check_server_log()
        self.check_disk()
        if int(time.time() // 60) % 10 == 0 or self.args.once:  # every 10 minutes
            self.check_data()
        if not self.args.no_tests:
            self.run_tests()
        self.save()


def install_startup(remove: bool) -> int:
    if not shotctl.WINDOWS:
        print('On Linux add `python3 scripts/bugwatch.py` as a systemd service; on a Mac, to Login Items.')
        return 1
    target = Path(os.environ['APPDATA']) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup' / 'Shot Caller bug watch.cmd'
    if remove:
        target.unlink(missing_ok=True)
        print('Removed: the bug watch no longer starts when you log in.')
        return 0
    target.write_text(f'@echo off\r\ncd /d "{shotctl.ROOT}"\r\nstart "Shot Caller bug watch" /min "{sys.executable}" "{Path(__file__).resolve()}"\r\n')
    print(f'The bug watch now starts when you log in (minimized window "Shot Caller bug watch").\n  {target}')
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog='bugwatch.py', description=__doc__.split('\n\n')[0])
    p.add_argument('--once', action='store_true', help='one round of checks, then exit')
    p.add_argument('--no-tests', action='store_true', help="don't run the test suite")
    p.add_argument('--every', type=int, default=60, help='seconds between rounds (default 60)')
    p.add_argument('--install-startup', action='store_true', help='start it when you log in to Windows')
    p.add_argument('--remove-startup', action='store_true')
    args = p.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except AttributeError:
            pass
    if args.install_startup or args.remove_startup:
        return install_startup(args.remove_startup)
    w = Watch(args)
    w.say(f'bug watch on: checking every {args.every}s. Report: {REPORT}')
    while True:
        try:
            w.round()
        except KeyboardInterrupt:
            raise
        except (Exception, SystemExit) as e:  # the watcher itself must never stop
            w.say(f'bug watch hit a problem of its own and carries on: {type(e).__name__}: {e}')
        if args.once:
            print(REPORT.read_text(encoding='utf-8') if REPORT.exists() else '')
            return 0
        try:
            time.sleep(args.every)
        except KeyboardInterrupt:
            w.say('bug watch stopped')
            return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
