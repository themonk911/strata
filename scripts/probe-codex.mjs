import { CodexClient } from '../server/api.mjs';
const client = new CodexClient();
try { console.log(JSON.stringify(await client.connect(), null, 2)); }
finally { client.close(); }
