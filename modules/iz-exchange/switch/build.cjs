const fs=require('node:fs/promises'),path=require('node:path'),{execFileSync}=require('node:child_process'),{deflateSync}=require('node:zlib');
const {python}=require('../../../core/host-tools.cjs');
async function main(){
 const runtime=python();
 execFileSync(runtime.file,[...runtime.args,path.join(__dirname,'assets.py')],{stdio:'inherit',windowsHide:true});
 await require('../../../sdk/build.cjs').buildApp(__dirname);
 for(const stage of ['vert','frag','comp']){const name=path.join(__dirname,'app.'+stage+'.spv');await fs.writeFile(name+'.deflate',deflateSync(await fs.readFile(name),{level:9}));}
 console.log('File Exchange shaders built. Repack with node sdk/pack.cjs modules/iz-exchange');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
