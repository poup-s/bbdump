// Databases reached through SSH: the ssh command line, what is accepted, and the .env read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const ssh = require(path.join(process.cwd(), 'dist/main/sshConfig.js'));

describe('values given to ssh', () => {
  test('aliases, hosts, users and addresses are accepted', () => {
    for (const v of ['my-vps', 'vps.example.com', '51.91.10.2', 'ubuntu', 'db_host', '[::1]', 'user@host']) {
      assert.equal(ssh.isSafeSshValue(v), true, v);
    }
  });
  test('anything ssh would read as an option, or a shell would interpret, is refused', () => {
    for (const v of ['-oProxyCommand=touch /tmp/x', '-p', 'host name', 'a;b', '$(id)', 'a`b`', '', 'x'.repeat(300), 'a\nb']) {
      assert.equal(ssh.isSafeSshValue(v), false, JSON.stringify(v));
    }
  });
});

describe('finding the env file on the server', () => {
  test('lines are grouped by file: real files, then copies, then examples; DATABASE_URL first', () => {
    const out = [
      '/srv/app/.env.example\tDATABASE_URL',
      '/home/deploy/api/.env.production.bak-20260921-204750\tDATABASE_URL',
      '/home/deploy/api/.env.production\tSHADOW_DATABASE_URL',
      '/home/deploy/api/.env.production\tDATABASE_URL',
      'garbage line',
      '/home/deploy/api/.env.production\tnot a name',
      'relative/.env\tDATABASE_URL',
    ].join('\n');
    assert.deepEqual(ssh.parseEnvSearch(out), [
      { file: '/home/deploy/api/.env.production', variables: ['DATABASE_URL', 'SHADOW_DATABASE_URL'], example: false, copy: false },
      { file: '/home/deploy/api/.env.production.bak-20260921-204750', variables: ['DATABASE_URL'], example: false, copy: true },
      { file: '/srv/app/.env.example', variables: ['DATABASE_URL'], example: true, copy: false },
    ]);
  });
  test('the script finds the files, skips node_modules and prints names, never values', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-envsearch-'));
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
    write('apps/api/.env.production', 'NODE_ENV=production\nDATABASE_URL="postgresql://app:s3cret@localhost:5432/appdb?schema=public"\n');
    write('apps/api/.env.example', "export DATABASE_URL='postgres://user:password@localhost/db'\n");
    write('apps/web/.env', 'REDIS_URL=redis://localhost:6379\n');
    write('apps/api/node_modules/pkg/.env', 'DATABASE_URL=postgres://x:y@h/z\n');
    try {
      const out = execFileSync('sh', ['-s'], { input: ssh.ENV_SEARCH_SCRIPT, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000 });
      assert.ok(!out.includes('s3cret') && !out.includes('password'), 'no secret leaves the server');
      const mine = ssh.parseEnvSearch(out).filter(m => m.file.startsWith(home));
      assert.deepEqual(mine.map(m => [path.relative(home, m.file), m.variables, m.example]), [
        ['apps/api/.env.production', ['DATABASE_URL'], false],
        ['apps/api/.env.example', ['DATABASE_URL'], true],
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ports as the form sends them', () => {
  test('an emptied SSH port is left out, so the alias decides (Port 4022 in ~/.ssh/config)', () => {
    const n = ssh.normalizeSshPorts({ host: 'my-vps', port: '', remoteHost: 'localhost', remotePort: 5432 });
    assert.equal(n.port, undefined);
    assert.equal(ssh.baseSshOptions({ host: 'my-vps', port: n.port }).includes('-p'), false);
  });
  test('an emptied database port is PostgreSQL\'s default', () => {
    assert.equal(ssh.normalizeSshPorts({ remotePort: '' }).remotePort, 5432);
    assert.equal(ssh.normalizeSshPorts({}).remotePort, 5432);
  });
  test('typed ports are kept, as numbers; nonsense is dropped', () => {
    assert.deepEqual(ssh.normalizeSshPorts({ port: '4022', remotePort: 6543 }), { port: 4022, remotePort: 6543 });
    assert.equal(ssh.normalizeSshPorts({ port: 70000 }).port, undefined);
  });
});

describe('ssh config', () => {
  const config = `
Host my-vps
  HostName 51.91.10.2
  User ubuntu
Host staging prod-*  !nope
Host *
  ServerAliveInterval 30
Include config.d/*
  include ~/.ssh/work
`;
  test('aliases without wildcards, in order, no duplicates', () => {
    assert.deepEqual(ssh.parseSshConfigHosts(config + '\nHost my-vps\n'), ['my-vps', 'staging']);
  });
  test('includes', () => {
    assert.deepEqual(ssh.parseSshConfigIncludes(config), ['config.d/*', '~/.ssh/work']);
  });
  test('ssh -G output', () => {
    assert.deepEqual(ssh.parseSshG('user ubuntu\nhostname 51.91.10.2\nport 2222\nidentityfile ~/.ssh/id_ed25519\n'),
      { user: 'ubuntu', hostname: '51.91.10.2', port: 2222 });
  });
});

describe('the tunnel command', () => {
  test('local forward on 127.0.0.1 only, no prompts, the host after "--"', () => {
    const args = ssh.tunnelArgs({ host: 'my-vps' }, 61842, 'localhost', 5432);
    assert.deepEqual(args.slice(0, 2), ['-N', '-T']);
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('ExitOnForwardFailure=yes'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:61842:localhost:5432');
    assert.deepEqual(args.slice(-2), ['--', 'my-vps']);
    assert.ok(!args.includes('-p') && !args.includes('-l'));
  });
  test('explicit user, port and config file; trusting a new key only when asked', () => {
    const args = ssh.tunnelArgs({ host: 'vps.example.com', user: 'deploy', port: 2222 }, 1, 'localhost', 5432, { configFile: '/tmp/cfg', acceptNewHostKey: true });
    assert.deepEqual(args.slice(args.indexOf('-F'), args.indexOf('-F') + 2), ['-F', '/tmp/cfg']);
    assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
    assert.equal(args[args.indexOf('-p') + 1], '2222');
    assert.equal(args[args.indexOf('-l') + 1], 'deploy');
  });
});

describe('ssh errors', () => {
  const cases = {
    'git@x: Permission denied (publickey).': 'auth',
    'No ED25519 host key is known for x and you have requested strict checking.\r\nHost key verification failed.': 'unknown-host',
    '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@': 'host-changed',
    'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known': 'dns',
    'ssh: connect to host 10.0.0.1 port 22: Operation timed out': 'timeout',
    'ssh: connect to host 127.0.0.1 port 22: Connection refused': 'unreachable',
    'bind [127.0.0.1]:5432: Address already in use': 'port-in-use',
    'something else': 'other',
  };
  for (const [stderr, code] of Object.entries(cases)) {
    test(code, () => assert.equal(ssh.classifySshError(stderr), code));
  }
});

describe('reading the database URL from a .env on the server', () => {
  test('KEY=value, export, quotes, comments', () => {
    assert.equal(ssh.parseEnvLine('DATABASE_URL=postgresql://u:p@localhost:5432/db', 'DATABASE_URL'), 'postgresql://u:p@localhost:5432/db');
    assert.equal(ssh.parseEnvLine('export DATABASE_URL="postgresql://u:p#1@h/db"', 'DATABASE_URL'), 'postgresql://u:p#1@h/db');
    assert.equal(ssh.parseEnvLine("DATABASE_URL='postgresql://u:p@h/db' # prod", 'DATABASE_URL'), 'postgresql://u:p@h/db');
    assert.equal(ssh.parseEnvLine('DATABASE_URL=postgresql://u:p@h/db # prod', 'DATABASE_URL'), 'postgresql://u:p@h/db');
    assert.equal(ssh.parseEnvLine('OTHER_URL=x', 'DATABASE_URL'), null);
  });
  test('variable names are checked, paths quoted for the remote shell', () => {
    assert.throws(() => ssh.readEnvCommand('/srv/.env', 'X;rm -rf /'));
    assert.throws(() => ssh.readEnvCommand('/srv/.env\nid', 'DATABASE_URL'));
    const command = ssh.readEnvCommand("/home/bob/it's here/.env.production", 'DATABASE_URL');
    // A POSIX shell must read back exactly the pattern and the path, nothing executed
    const out = execFileSync('sh', ['-c', `printf '%s\\n' ${command.replace(/^grep -m1 -E /, '')}`]).toString().split('\n');
    assert.equal(out[0], '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=');
    assert.equal(out[1], "/home/bob/it's here/.env.production");
  });
  test('URL host: localhost kept, a container name sends the tunnel to localhost', () => {
    assert.deepEqual(ssh.remoteHostFromUrlHost('localhost'), { host: 'localhost' });
    assert.deepEqual(ssh.remoteHostFromUrlHost('postgres'), { host: 'localhost', containerName: 'postgres' });
    assert.deepEqual(ssh.remoteHostFromUrlHost('10.0.0.5'), { host: '10.0.0.5' });
    assert.deepEqual(ssh.remoteHostFromUrlHost('db.internal.lan'), { host: 'db.internal.lan' });
  });
});
