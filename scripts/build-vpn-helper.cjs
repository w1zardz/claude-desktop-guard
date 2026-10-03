'use strict';

const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const platforms = { darwin: 'darwin', win32: 'windows' };
const architectures = { x64: 'amd64', arm64: 'arm64' };
const goos = platforms[process.platform];
const architecture = process.env.CDG_HELPER_ARCH || process.arch;
if (!goos || !architectures[architecture]) throw new Error('VPN helper build supports macOS/Windows on x64/arm64 only');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'native', 'bin');
mkdirSync(destination, { recursive: true });
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(destination, `vpn-helper${goos === 'windows' ? '.exe' : ''}`), '.'], {
  cwd: path.join(root, 'native', 'vpn-helper'), shell: false, stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: architectures[architecture] },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
