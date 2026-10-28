const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function check(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('CHECK-WINDOWS.cmd [--build-tools] [--arm]');
    console.log('Checks host dependencies, descriptors and the packaged modules without connecting to hardware.');
    console.log('--build-tools also checks the optional shader compiler.');
    return 0;
  }
  const unknown = args.filter(arg => !['--build-tools','--arm'].includes(arg));
  if (unknown.length) throw Error('Unknown check option: ' + unknown.join(' '));
  let exitCode = 0;
  for (const [script, extra] of [
    ['hardware/dependencies.cjs', args],
    ['sdk/check.cjs', []],
  ]) {
    console.log('\nChecking ' + script);
    const result = spawnSync(process.execPath, [path.join(root, script), ...extra], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) exitCode = 1;
  }
  console.log(exitCode ? '\nChecks failed. See the messages above.' : '\nAll local checks passed.');
  return exitCode;
}

if (require.main === module) {
  try { process.exitCode = check(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { check };
