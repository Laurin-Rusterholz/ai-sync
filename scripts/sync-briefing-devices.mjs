import {copyFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../public/',import.meta.url));
export const files=['quantus-briefing-device.js','quantus-briefing-device.css','quantus-briefing-device-controller.mjs','quantus-v3-command-client.mjs','quantus-v3-briefing-answers.mjs','quantus-v4-quick-capture.mjs'];
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--mobile'||args[2]!=='--tablet')throw Error('Usage: node scripts/sync-briefing-devices.mjs --mobile <mobile-management> --tablet <quantus-tablet-version>');
for(const target of [resolve(args[1]),join(resolve(args[3]),'public')]){await mkdir(target,{recursive:true});for(const file of files)await copyFile(join(source,file),join(target,file));console.log('Shared briefing assets copied to '+target)}
