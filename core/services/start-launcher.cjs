// Compatibility entry: use the current session/shell orchestration.
const current=require('./start-run12.cjs');
module.exports=current;
if(require.main===module)current.startCli();
