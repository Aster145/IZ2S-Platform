// Rebuild only this shell. The primary IZlauncher and current console session are untouched.
const {execFileSync}=require('node:child_process'),path=require('node:path');
const {python}=require('../../core/host-tools.cjs');
async function main(){
 await require('../../sdk/build.cjs').buildLauncher(path.join(__dirname,'server'));
 const runtime=python();
 execFileSync(runtime.file,[...runtime.args,path.join(__dirname,'server/ps-assets.py')],{stdio:'inherit',windowsHide:true});
 await require('./server/build-app.cjs').build();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
