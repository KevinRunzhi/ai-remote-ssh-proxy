import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSshCommand, normalizeConnection, normalizeProxy, port } from '../scripts/input.mjs';

test('简单直接 SSH 命令、用户名选项与 alias 正确解析', () => {
  assert.deepEqual(parseSshCommand('ssh -p 2222 root@example.test'), { inputMode: 'direct', hostname: 'example.test', username: 'root', sshPort: 2222 });
  assert.deepEqual(parseSshCommand('ssh -p 22 -l user "example.test"'), { inputMode: 'direct', hostname: 'example.test', username: 'user', sshPort: 22 });
  assert.deepEqual(parseSshCommand("ssh 'sample-alias'"), { inputMode: 'alias', host: 'sample-alias' });
  assert.equal(parseSshCommand('ssh user@127.0.0.1').sshPort, 22);
});

test('注入、重复/矛盾字段、未知选项和附加命令一律拒绝', () => {
  for (const command of [
    'ssh -p 2222 alias', 'ssh -p 22 -p 22 user@host', 'ssh -l user user@host',
    'ssh -o ProxyCommand=bad alias', 'ssh -i key alias', 'ssh -J jump alias', 'ssh -F file alias',
    'ssh -R 17890:host:80 alias', 'ssh user@host ls', 'ssh user@host;echo bad',
    'ssh user@host | cmd', 'ssh user@$(bad)', 'ssh user@`bad`', 'ssh user@host > file',
    'ssh "alias', 'ssh ', 'ssh\nuser@host', 'ssh user@host\\bad', 'ssh -p 0 user@host',
    'ssh -p 65536 user@host', 'ssh -p 22.5 user@host', 'ssh user@host@other',
  ]) assert.throws(() => parseSshCommand(command), undefined, command);
});

test('字段严格类型、范围与主机格式；代理不接受凭证或外部地址', () => {
  for (const hostname of ['-host', 'bad_name', '256.0.0.1', '127.1', '012.1.1.1', 'https://host', '::1', 'host..test', 'host\n']) {
    assert.throws(() => normalizeConnection({ inputMode: 'direct', username: 'root', hostname }));
  }
  for (const value of [[], null, true, '', '1e4', '1.5', ' 22']) assert.throws(() => port(value, 1));
  assert.deepEqual(normalizeProxy('http://localhost:7897/'), { localProxy: 'http://127.0.0.1:7897', localPort: 7897 });
  for (const value of ['http://user:secret@127.0.0.1:7897', 'http://example.test:7897', 'http://127.0.0.1:7897/path', 'socks5://127.0.0.1:7897', 'http://127.0.0.1:80']) assert.throws(() => normalizeProxy(value));
});
