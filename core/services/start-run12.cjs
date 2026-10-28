// Compatibility entry; process orchestration belongs to session lifecycle.
const current=require('../session/console-runner.cjs');module.exports=current;
if(require.main===module)current.startCli();
