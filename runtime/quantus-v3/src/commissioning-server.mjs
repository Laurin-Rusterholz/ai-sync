#!/usr/bin/env node
/** Explicit container command for the source broker. Ordinary server.mjs and
 * its live gates are unchanged. Never log configuration or credential errors. */
import {createServer} from 'node:http';
import {createNodeRequestListener} from './http.mjs';
import {createCommissioningService,unavailableCommissioningService} from './commissioning-composition.mjs';
let app;
try { app=await createCommissioningService(); }
catch { app=unavailableCommissioningService();process.stderr.write('commissioning_not_configured\n'); }
const port=Number(process.env.PORT??8080);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_port');
createServer(createNodeRequestListener(app,{maxBytes:512*1024})).listen(port,'0.0.0.0');
