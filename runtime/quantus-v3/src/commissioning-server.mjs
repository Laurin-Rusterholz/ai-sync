#!/usr/bin/env node
/** Explicit container command for the source broker. Importing this module
 * must not start a server. Never log configuration or credential errors. */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createNodeRequestListener} from './http.mjs';
import {createCommissioningService,unavailableCommissioningService} from './commissioning-composition.mjs';
export async function startCommissioningServer(){
  let app;
  try { app=await createCommissioningService(); }
  catch { app=unavailableCommissioningService();process.stderr.write('commissioning_not_configured\n'); }
  const port=Number(process.env.PORT??8080);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_port');
  return createServer(createNodeRequestListener(app,{maxBytes:512*1024})).listen(port,'0.0.0.0');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await startCommissioningServer();
