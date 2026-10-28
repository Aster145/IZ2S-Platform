const fs=require('node:fs'),path=require('node:path');
function tool(environment,name){
 const executable=process.platform==='win32'?name+'.exe':name;
 const candidates=[path.resolve(__dirname,'../../data/runtime/tools',executable),path.resolve(__dirname,'../../tools',executable),path.resolve(__dirname,'../../tools',name)];
 if(process.env.VULKAN_SDK)candidates.push(path.join(process.env.VULKAN_SDK,'Bin',executable));
 return process.env[environment]||candidates.find(p=>fs.existsSync(p))||executable;
}
module.exports={tool};
