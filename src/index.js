'use strict';

const { getSystemInfo } = require('./system');
const { listProfiles } = require('./profiles');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.server) {
    const { startServer } = require('./server');
    startServer(parseInt(args.port || '17890', 10));
    return;
  }
  if (args.system) {
    console.log(JSON.stringify(getSystemInfo(), null, 2));
    return;
  }
  if (args.profiles) {
    console.log(JSON.stringify(listProfiles(), null, 2));
    return;
  }
  if (args.java) {
    const { findJavaExecutables, selectJava } = require('./java');
    const found = findJavaExecutables();
    console.log(JSON.stringify({ found, sel120: selectJava('1.20.1', found), sel18: selectJava('1.8.9', found) }, null, 2));
    return;
  }
  if (args.versions) {
    const { listVersions } = require('./minecraft');
    const v = await listVersions();
    console.log('latest:', JSON.stringify(v.latest));
    console.log(v.versions.slice(0, 15).map(x => `${x.id} [${x.type}]`).join('\n'));
    return;
  }
  if (args.launch) {
    const { prepareLaunch } = require('./prepare');
    const { launch } = require('./launcher');
    const version = args.version || '1.20.1';
    const username = args.username || 'Player';
    const onLog = (l) => process.stdout.write(l.endsWith('\n') ? l : l + '\n');
    const { cmd, java, instanceDir } = await prepareLaunch({
      version,
      username,
      profile: args.profile,
      fabric: !!args.fabric,
      mods: !!args.mods,
      instanceDir: args.instanceDir,
      onLog,
    });
    console.log('java:', java.path);
    console.log(`"${cmd.javaExe}" ${cmd.args.slice(0, 6).join(' ')} ...`);
    if (args.dry) { console.log('dry-run OK (игра не запущена)'); return; }
    const child = launch(cmd, { onLog });
    console.log('pid:', child.pid);
    return;
  }
  console.log('FPS Launcher backend. Flags: --system --profiles --java --versions --launch --server');
  console.log('Example: node src/index.js --launch --version 1.20.1 --username Steve --profile potato --dry');
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { getSystemInfo, listProfiles };
