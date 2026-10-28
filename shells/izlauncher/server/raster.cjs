const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {python}=require('../../../core/host-tools.cjs');
async function raster(catalog,directory,label='focus-catalog'){
 await require('../../../core/services/app-catalog.cjs').raster(catalog,directory,label);
 const input=path.join(directory,label+'.json'),output=path.join(directory,label+'.bin');
 const runtime=python();
 await promisify(execFile)(runtime.file,[...runtime.args,path.join(__dirname,'hero-text.py'),input,output],{timeout:15000,maxBuffer:65536,windowsHide:true});return fs.readFile(output);
}
module.exports={raster};
