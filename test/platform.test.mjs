// Tests for the onboarding platform layer (src/main/platform), run against the
// compiled output: `npm test` runs tsc first.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const linux = require('../dist/main/platform/linux.js');
const environment = require('../dist/main/platform/environment.js');
const install = require('../dist/main/platform/install.js');
const macos = require('../dist/main/platform/macos.js');
const windows = require('../dist/main/platform/windows.js');

const OS_RELEASES = {
  ubuntu: `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian`,
  debian: `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian`,
  linuxmint: `NAME="Linux Mint"
VERSION="22 (Wilma)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 22"
VERSION_ID="22"`,
  fedora: `NAME="Fedora Linux"
VERSION="41 (Workstation Edition)"
ID=fedora
VERSION_ID=41
PRETTY_NAME="Fedora Linux 41 (Workstation Edition)"`,
  rhel: `NAME="Red Hat Enterprise Linux"
VERSION="9.4 (Plow)"
ID="rhel"
ID_LIKE="fedora"
VERSION_ID="9.4"
PRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"`,
  rocky: `NAME="Rocky Linux"
VERSION="9.4 (Blue Onyx)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.4"
PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"`,
  // An unlisted RHEL rebuild: only ID_LIKE identifies it
  rhelLike: `NAME="Some EL"
ID="someel"
ID_LIKE="rhel centos fedora"
VERSION_ID="9"
PRETTY_NAME="Some EL 9"`,
  arch: `NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling`,
  manjaro: `NAME="Manjaro Linux"
PRETTY_NAME="Manjaro Linux"
ID=manjaro
ID_LIKE=arch
BUILD_ID=rolling`,
  tumbleweed: `NAME="openSUSE Tumbleweed"
# VERSION="20241001"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
VERSION_ID="20241001"
PRETTY_NAME="openSUSE Tumbleweed"`,
  alpine: `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.20.3
PRETTY_NAME="Alpine Linux v3.20"`,
};

const FAMILIES = ['debian', 'fedora', 'arch', 'suse'];
const COMPONENTS = ['client-tools', 'server'];

function bashSyntaxOk(text) {
  const result = spawnSync('bash', ['-n'], { input: text, encoding: 'utf8' });
  return { ok: result.status === 0, stderr: result.stderr };
}

describe('os-release parsing', () => {
  const expected = {
    ubuntu: ['ubuntu', 'debian', 'Ubuntu 24.04.1 LTS', '24.04'],
    debian: ['debian', 'debian', 'Debian GNU/Linux 12 (bookworm)', '12'],
    linuxmint: ['linuxmint', 'debian', 'Linux Mint 22', '22'],
    fedora: ['fedora', 'fedora', 'Fedora Linux 41 (Workstation Edition)', '41'],
    rhel: ['rhel', 'fedora', 'Red Hat Enterprise Linux 9.4 (Plow)', '9.4'],
    rocky: ['rocky', 'fedora', 'Rocky Linux 9.4 (Blue Onyx)', '9.4'],
    rhelLike: ['someel', 'fedora', 'Some EL 9', '9'],
    arch: ['arch', 'arch', 'Arch Linux', undefined],
    manjaro: ['manjaro', 'arch', 'Manjaro Linux', undefined],
    tumbleweed: ['opensuse-tumbleweed', 'suse', 'openSUSE Tumbleweed', '20241001'],
    alpine: ['alpine', 'unknown', 'Alpine Linux v3.20', '3.20.3'],
  };
  for (const [name, [id, family, label, version]] of Object.entries(expected)) {
    test(name, () => {
      const distro = linux.parseDistro(OS_RELEASES[name]);
      assert.deepEqual(distro, { id, family, name: label, version });
    });
  }

  test('quotes, escapes and comments', () => {
    const fields = linux.parseOsRelease('# comment\nA="x \\"y\\""\nB=\'z\'\n\nC=plain\nbroken line');
    assert.deepEqual(fields, { A: 'x "y"', B: 'z', C: 'plain' });
  });

  test('empty os-release is unknown', () => {
    assert.deepEqual(linux.parseDistro(''), { id: 'linux', name: 'Linux', family: 'unknown', version: undefined });
  });
});

describe('username validation', () => {
  for (const good of ['alice', 'bob', '_svc', 'john-doe', 'user_1', 'MACHINE$']) {
    test(`accepts ${good}`, () => assert.equal(linux.isValidUsername(good), true));
  }
  for (const bad of ['a;rm -rf /', '', '1abc', "o'brien", 'a b', '$(id)', 'x`id`', 'a\nb', '-rf', 'a'.repeat(40)]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(linux.isValidUsername(bad), false));
  }
  test('server script refuses an injected user name', () => {
    assert.throws(() => linux.buildLinuxScript('server', 'debian', 'a;rm -rf /'), /Invalid user name/);
  });
  test('unknown family is refused', () => {
    assert.throws(() => linux.buildLinuxScript('client-tools', 'unknown', 'alice'), /Unsupported/);
  });
});

describe('Linux scripts', () => {
  test('package names', () => {
    assert.deepEqual(linux.linuxPackages('debian', 'client-tools'), ['postgresql-client']);
    assert.deepEqual(linux.linuxPackages('debian', 'server'), ['postgresql', 'postgresql-contrib']);
    assert.deepEqual(linux.linuxPackages('fedora', 'client-tools'), ['postgresql']);
    assert.deepEqual(linux.linuxPackages('fedora', 'server'), ['postgresql-server', 'postgresql-contrib']);
    assert.deepEqual(linux.linuxPackages('arch', 'client-tools'), ['postgresql']);
    assert.deepEqual(linux.linuxPackages('arch', 'server'), ['postgresql']);
    assert.deepEqual(linux.linuxPackages('suse', 'client-tools'), ['postgresql']);
    assert.deepEqual(linux.linuxPackages('suse', 'server'), ['postgresql-server', 'postgresql-contrib']);
    assert.deepEqual(linux.linuxPackages('unknown', 'server'), []);
  });

  test('debian', () => {
    const client = linux.buildLinuxScript('client-tools', 'debian', 'alice');
    assert.match(client, /DEBIAN_FRONTEND=noninteractive/);
    assert.match(client, /apt-get .*install -y -q postgresql-client\n/);
    assert.doesNotMatch(client, /systemctl|createuser/);

    const server = linux.buildLinuxScript('server', 'debian', 'alice');
    assert.match(server, /install -y -q postgresql postgresql-contrib/);
    assert.match(server, /systemctl enable --now postgresql/);
    assert.doesNotMatch(server, /initdb/);
  });

  test('fedora', () => {
    const client = linux.buildLinuxScript('client-tools', 'fedora', 'alice');
    assert.match(client, /"\$PM" install -y postgresql\n/);
    const server = linux.buildLinuxScript('server', 'fedora', 'alice');
    assert.match(server, /"\$PM" install -y postgresql-server postgresql-contrib/);
    assert.match(server, /if \[ ! -s \/var\/lib\/pgsql\/data\/PG_VERSION \]; then\n\s+postgresql-setup --initdb/);
    assert.match(server, /systemctl enable --now postgresql/);
  });

  test('arch', () => {
    const client = linux.buildLinuxScript('client-tools', 'arch', 'alice');
    assert.match(client, /pacman -S --noconfirm --needed postgresql/);
    assert.doesNotMatch(client, /initdb|systemctl/);
    const server = linux.buildLinuxScript('server', 'arch', 'alice');
    assert.match(server, /if \[ ! -s \/var\/lib\/postgres\/data\/PG_VERSION \]/);
    assert.match(server, /su - postgres -c "initdb -D \/var\/lib\/postgres\/data/);
    assert.match(server, /systemctl enable --now postgresql/);
  });

  test('suse', () => {
    const client = linux.buildLinuxScript('client-tools', 'suse', 'alice');
    assert.match(client, /zypper --non-interactive install postgresql\n/);
    const server = linux.buildLinuxScript('server', 'suse', 'alice');
    assert.match(server, /zypper --non-interactive install postgresql-server postgresql-contrib/);
    assert.match(server, /systemctl enable --now postgresql/);
  });

  for (const family of FAMILIES) {
    test(`${family} server: readiness wait and role for the OS user`, () => {
      const server = linux.buildLinuxScript('server', family, 'alice');
      assert.match(server, /set -euo pipefail/);
      assert.match(server, /for _ in \$\(seq 1 30\)/);
      assert.match(server, /pg_isready/);
      assert.match(server, /SELECT 1 FROM pg_roles WHERE rolname='alice'/);
      assert.match(server, /su - postgres -c "createuser -s alice"/);
    });
  }

  test('no role step when the OS user is postgres', () => {
    const server = linux.buildLinuxScript('server', 'debian', 'postgres');
    assert.doesNotMatch(server, /createuser/);
  });

  for (const family of FAMILIES) {
    for (const component of COMPONENTS) {
      test(`bash -n: ${family} ${component} script and sudo command`, () => {
        const script = linux.buildLinuxScript(component, family, 'alice');
        const scriptCheck = bashSyntaxOk(script);
        assert.ok(scriptCheck.ok, scriptCheck.stderr);
        const commandCheck = bashSyntaxOk(linux.sudoCommand(script));
        assert.ok(commandCheck.ok, commandCheck.stderr);
      });
    }
  }

  test('bash -n: user name ending with $', () => {
    const check = bashSyntaxOk(linux.buildLinuxScript('server', 'debian', 'host$'));
    assert.ok(check.ok, check.stderr);
  });

  test('progress lines', () => {
    assert.deepEqual(linux.parseStepLine('==> [60%] Starting PostgreSQL'), { percent: 60, message: 'Starting PostgreSQL' });
    assert.equal(linux.parseStepLine('Reading package lists...'), null);
  });

  test('every script step maps to a translated stage', () => {
    const steps = linux.buildLinuxScript('server', 'debian', 'alice')
      .split('\n')
      .map((line) => line.match(/^step (\d+) /))
      .filter(Boolean)
      .map((match) => install.linuxStage(Number(match[1])));
    assert.deepEqual(steps, ['packages', 'initdb', 'service', 'waitReady', 'role', 'done']);
  });

  test('the sudo command carries the script verbatim', () => {
    const script = linux.buildLinuxScript('server', 'debian', 'alice');
    const command = linux.sudoCommand(script);
    assert.ok(command.startsWith(`sudo bash -c "$(cat <<'BBDUMP_SETUP'\n`));
    assert.ok(command.endsWith('\nBBDUMP_SETUP\n)"'));
    assert.ok(command.includes(script.trimEnd()));
  });

  test('the sudo command runs the script unchanged (without sudo)', () => {
    const script = `echo "$((1+1)) 'q' $HOME"\n`;
    const command = linux.sudoCommand(script).replace(/^sudo /, '');
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: '/h' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2 'q' /h\n");
  });
});

describe('package manager and auto install', () => {
  const fakeWhich = (available) => async (name) => (available[name] ?? null);

  test('debian family uses apt-get', async () => {
    const pm = await environment.detectPackageManager('linux', 'debian', fakeWhich({ 'apt-get': '/usr/bin/apt-get' }));
    assert.deepEqual(pm, { id: 'apt', path: '/usr/bin/apt-get' });
  });
  test('fedora family prefers dnf, falls back to yum', async () => {
    assert.deepEqual(
      await environment.detectPackageManager('linux', 'fedora', fakeWhich({ dnf: '/usr/bin/dnf', yum: '/usr/bin/yum' })),
      { id: 'dnf', path: '/usr/bin/dnf' });
    assert.deepEqual(
      await environment.detectPackageManager('linux', 'fedora', fakeWhich({ yum: '/usr/bin/yum' })),
      { id: 'yum', path: '/usr/bin/yum' });
  });
  test('unknown family: any known package manager', async () => {
    assert.deepEqual(
      await environment.detectPackageManager('linux', 'unknown', fakeWhich({ zypper: '/usr/bin/zypper' })),
      { id: 'zypper', path: '/usr/bin/zypper' });
    assert.equal(await environment.detectPackageManager('linux', 'unknown', fakeWhich({})), null);
  });
  test('macOS: brew', async () => {
    assert.deepEqual(
      await environment.detectPackageManager('macos', 'unknown', fakeWhich({ brew: '/opt/homebrew/bin/brew' })),
      { id: 'brew', path: '/opt/homebrew/bin/brew' });
  });
  test('canAutoInstall', () => {
    const apt = { id: 'apt', path: '/usr/bin/apt-get' };
    assert.equal(environment.computeCanAutoInstall('linux', apt, 'debian', true), true);
    assert.equal(environment.computeCanAutoInstall('linux', apt, 'debian', false), false);
    assert.equal(environment.computeCanAutoInstall('linux', null, 'debian', true), false);
    assert.equal(environment.computeCanAutoInstall('linux', apt, 'unknown', true), false);
    assert.equal(environment.computeCanAutoInstall('macos', { id: 'brew', path: '/opt/homebrew/bin/brew' }, 'unknown', false), true);
    assert.equal(environment.computeCanAutoInstall('macos', null, 'unknown', false), false);
    assert.equal(environment.computeCanAutoInstall('windows', { id: 'winget' }, 'unknown', false), false);
  });
  test('install family falls back to the package manager', () => {
    assert.equal(environment.installFamily({ distro: { id: 'x', name: 'X', family: 'unknown' }, packageManager: { id: 'pacman' } }), 'arch');
    assert.equal(environment.installFamily({ distro: { id: 'ubuntu', name: 'U', family: 'debian' }, packageManager: null }), 'debian');
  });
  test('service name parsing', () => {
    assert.equal(environment.parseBrewServices(
      'Name          Status  User  File\npostgresql@18 none\npostgresql@17 started alice ~/Library/LaunchAgents/homebrew.mxcl.postgresql@17.plist\nredis none'),
    'postgresql@17');
    assert.equal(environment.parseBrewServices('Name Status\nredis started'), undefined);
    assert.equal(environment.parseSystemdUnits(
      'postgresql.service enabled enabled\npostgresql@.service indirect enabled'), 'postgresql');
    assert.equal(environment.parseSystemdUnits('postgresql-16.service disabled disabled'), 'postgresql-16');
  });
});

describe('install plans', () => {
  const base = {
    arch: 'x64',
    supported: true,
    clientTools: { pgDump: { installed: false }, psql: { installed: false }, pgRestore: { installed: false }, ready: false },
    server: { installed: false, running: false, port: 5432, canConnect: false },
    docker: { installed: false, running: false },
  };

  test('ubuntu with pkexec: automatic, sudo command', () => {
    const env = {
      ...base, os: 'linux', osLabel: 'Ubuntu 24.04 LTS',
      distro: { id: 'ubuntu', name: 'Ubuntu 24.04 LTS', family: 'debian', version: '24.04' },
      packageManager: { id: 'apt', path: '/usr/bin/apt-get' }, canAutoInstall: true,
    };
    const client = install.planFor('client-tools', env, 'alice');
    assert.equal(client.automatic, true);
    assert.ok(client.command.startsWith(`sudo bash -c "$(cat <<'BBDUMP_SETUP'`));
    assert.match(client.command, /install -y -q postgresql-client/);
    const server = install.planFor('server', env, 'alice');
    assert.match(server.command, /createuser -s alice/);
    assert.deepEqual(install.planFor('homebrew', env, 'alice'), { component: 'homebrew', automatic: false, command: '' });
  });

  test('linux without pkexec: manual command only', () => {
    const env = {
      ...base, os: 'linux', osLabel: 'Fedora', distro: { id: 'fedora', name: 'Fedora', family: 'fedora' },
      packageManager: { id: 'dnf', path: '/usr/bin/dnf' }, canAutoInstall: false,
    };
    const plan = install.planFor('server', env, 'alice');
    assert.equal(plan.automatic, false);
    assert.match(plan.command, /postgresql-setup --initdb/);
  });

  test('linux with an invalid user name: no server command', () => {
    const env = {
      ...base, os: 'linux', osLabel: 'Debian', distro: { id: 'debian', name: 'Debian', family: 'debian' },
      packageManager: { id: 'apt', path: '/usr/bin/apt-get' }, canAutoInstall: true,
    };
    assert.deepEqual(install.planFor('server', env, 'a;rm -rf /'), { component: 'server', automatic: false, command: '' });
  });

  test('alpine: nothing automatic', () => {
    const env = {
      ...base, os: 'linux', osLabel: 'Alpine', distro: { id: 'alpine', name: 'Alpine', family: 'unknown' },
      packageManager: null, canAutoInstall: false,
    };
    assert.deepEqual(install.planFor('client-tools', env, 'alice'), { component: 'client-tools', automatic: false, command: '' });
  });

  test('macOS: absolute brew path', () => {
    const env = {
      ...base, os: 'macos', arch: 'arm64', osLabel: 'macOS 15.4',
      packageManager: { id: 'brew', path: '/opt/homebrew/bin/brew' }, canAutoInstall: true,
      homebrew: { installed: true, path: '/opt/homebrew/bin/brew' },
    };
    assert.deepEqual(install.planFor('client-tools', env), {
      component: 'client-tools', automatic: true, command: '/opt/homebrew/bin/brew install libpq',
    });
    assert.deepEqual(install.planFor('server', env), {
      component: 'server', automatic: true,
      command: '/opt/homebrew/bin/brew install postgresql@17 && /opt/homebrew/bin/brew services start postgresql@17',
    });
    assert.equal(install.planFor('homebrew', env).command, macos.HOMEBREW_INSTALL_COMMAND);
  });

  test('macOS without Homebrew: not automatic, default brew path', () => {
    const env = { ...base, os: 'macos', arch: 'x64', osLabel: 'macOS 14', packageManager: null, canAutoInstall: false, homebrew: { installed: false } };
    const plan = install.planFor('client-tools', env);
    assert.equal(plan.automatic, false);
    assert.equal(plan.command, '/usr/local/bin/brew install libpq');
    assert.equal(install.planFor('homebrew', env).automatic, true);
  });

  test('Windows: plans only, winget', () => {
    const env = { ...base, os: 'windows', osLabel: 'Windows 10.0', supported: false, packageManager: { id: 'winget' }, canAutoInstall: false };
    const plan = install.planFor('server', env);
    assert.equal(plan.automatic, false);
    assert.match(plan.command, /^winget install -e --id PostgreSQL\.PostgreSQL\.17/);
    assert.equal(windows.WINDOWS_SUPPORTED, false);
  });

  test('component validation', () => {
    assert.equal(install.isSetupComponent('server'), true);
    assert.equal(install.isSetupComponent('docker'), false);
    assert.equal(install.isSetupComponent(42), false);
  });
});

describe('detectEnvironment on this machine', { skip: process.platform === 'win32' }, () => {
  test('returns a complete environment without throwing', { timeout: 60000 }, async () => {
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-test-'));
    process.chdir(tmp); // the Electron stub makes logs go to the cwd
    try {
      require('./electronStub.cjs');
      const env = await environment.detectEnvironment();
      assert.equal(env.os, process.platform === 'darwin' ? 'macos' : 'linux');
      assert.equal(env.supported, true);
      assert.equal(typeof env.osLabel, 'string');
      assert.equal(typeof env.canAutoInstall, 'boolean');
      assert.equal(env.server.port, 5432);
      assert.equal(env.clientTools.ready,
        env.clientTools.pgDump.installed && env.clientTools.psql.installed && env.clientTools.pgRestore.installed);
      assert.equal(typeof env.docker.installed, 'boolean');
      if (env.os === 'linux') assert.ok(env.distro);
      if (env.os === 'macos') assert.ok(env.homebrew);
    } finally {
      process.chdir(cwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
