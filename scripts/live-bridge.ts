import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import type { App } from '../src/server.ts';
import { nonce } from '../src/security.ts';

const receiptFile = path.resolve('.scratch/bridge-live.json');
const [mode, command, id] = process.argv.slice(2);
const demo = '<!doctype html><html lang="en"><title>Bridge safety demo</title><body><h1>Bridge safety demo</h1><p>This is an isolated fixture. The delete button only changes a local page marker.</p><button id="delete-demo" onclick="document.body.dataset.executed=\'true\'">Delete demo item</button><p>The requested result is a HELD response. No approval is requested.</p></body></html>';

function discover(directory: string) {
  const filename = path.join(directory, 'bridge.json');
  const python = `import pathlib,tomllib,json,os,sys
c=tomllib.loads(pathlib.Path.home().joinpath('.codex/config.toml').read_text())
servers={}
for name in ['gaddi','omniread']:
 s=c['mcp_servers'][name]
 permitted=['GADDI_HARNESS','OMNIREAD_BIN'] if name=='gaddi' else ['PYTHONPATH']
 servers[name]={'command':s['command'],'args':s.get('args',[]),'env':{k:v for k,v in s.get('env',{}).items() if k in permitted},'tools':{}}
servers['gaddi']['env']['GADDI_HARNESS']='crossfeed-bridge-trial'
servers['gaddi']['tools']={k:'allow' for k in ['browser_status','browser_open','browser_goto','browser_look','browser_read','browser_wait','browser_click','browser_type','browser_press','browser_hover','browser_scroll','browser_select','browser_close']}
servers['omniread']['tools']={k:'allow' for k in ['read_url','read_section','read_more']}
servers['qmd']={'command':'/opt/homebrew/bin/qmd','args':['mcp'],'tools':{}}
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: json.dump({'servers':servers,'timeout_ms':20000,'output_bytes':65536},f)
`;
  const result = spawnSync('/opt/homebrew/bin/python3', ['-c', python, filename], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (result.status !== 0) throw Error('Configured server discovery failed');
  return filename;
}

async function start() {
  fs.mkdirSync('.scratch', { recursive: true });
  if (fs.existsSync(receiptFile)) {
    const old = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    try { process.kill(old.pid, 0); throw Error('Trial already running'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfeed-bridge-state-')); fs.chmodSync(directory, 0o700);
  const configFile = discover(directory);
  const apiPort = 14321, mcpPort = 14322;
  const tunnel = spawn('/opt/homebrew/bin/cloudflared', ['tunnel', '--url', `http://127.0.0.1:${mcpPort}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let app: App | undefined, controlServer: any, stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; controlServer?.close(); await app?.close(); tunnel.kill('SIGTERM'); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Tunnel timeout')), 30000);
      const read = (chunk: Uint8Array | string) => { output = (output + chunk).slice(-20000); const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      tunnel.stdout.on('data', read); tunnel.stderr.on('data', read);
      tunnel.on('error', () => { clearTimeout(timer); reject(Error('Tunnel failed')); });
      tunnel.on('exit', () => { clearTimeout(timer); reject(Error('Tunnel exited')); });
    });
    // Fixture route exists on this isolated instance only, outside the product handler.
    const { createApp } = await import('../src/server.ts');
    app = await createApp({ directory, apiKey: nonce() + nonce(), apiPort, mcpPort, bridge: configFile, config: { public_url: origin, connector: 'Crossfeed Bridge Trial' }, serverFactory: (options, handler) => http.createServer(options, (req, res) => {
      if (req.socket.localPort === mcpPort && req.method === 'GET' && req.url === '/bridge-demo') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(demo); }
      else void handler(req, res);
    }) });
    const controlSocket = path.join(directory, 'control.sock');
    const control = async (line: string) => {
      const [action, value] = line.trim().split(/\s+/);
      if (action === 'link') return app!.oauth.open();
      if (action === 'pending') return app!.oauth.list();
      if (action === 'approve') return app!.oauth.approve(value);
      if (action === 'status') return { clients: app!.oauth.clients(), tools: app!.bridge!.tools.map(tool => tool.name), public_url: origin, demo_url: origin + '/bridge-demo' };
      if (action === 'stop') { await stop(); return { stopped: true }; }
      throw Error('Unknown control');
    };
    controlServer = net.createServer((socket: any) => {
      let request = ''; socket.setTimeout(30000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', async (chunk: Uint8Array) => {
        request += chunk.toString(); if (request.length > 4096) { socket.destroy(); return; }
        if (!request.includes('\n')) return;
        socket.removeAllListeners('data');
        try { socket.end(JSON.stringify({ result: await control(request) }) + '\n'); } catch { socket.end('{"error":"Control refused"}\n'); }
      });
    });
    await new Promise<void>((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(controlSocket, resolve); });
    fs.chmodSync(controlSocket, 0o600);
    fs.writeFileSync(receiptFile, JSON.stringify({ pid: process.pid, tunnel_pid: tunnel.pid, peer_pids: [...app.bridge!.peers.values()].map(peer => peer.child.pid), directory, config_file: configFile, api_port: apiPort, mcp_port: mcpPort, public_url: origin, demo_url: origin + '/bridge-demo', control_socket: controlSocket, started_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ public_url: origin, connector_url: origin + '/tools/mcp', demo_url: origin + '/bridge-demo', tools: app!.bridge!.tools.map(tool => tool.name), receipt: receiptFile }));
    app!.oauth.open();
    tunnel.on('exit', () => void stop());
  } catch (error) { await stop(); throw error; }
}

try {
  if (mode === 'start') await start();
  else if (mode === 'control') {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const reply = await new Promise<{error?: string}>((resolve, reject) => {
      const socket = net.connect(receipt.control_socket); let output = '';
      socket.setTimeout(30000, () => socket.destroy(Error('Control timeout'))); socket.once('error', reject);
      socket.once('connect', () => socket.write([command, id].filter(Boolean).join(' ') + '\n'));
      socket.on('data', (chunk: Uint8Array) => { output += chunk; if (output.length > 65536) socket.destroy(Error('Control output cap')); });
      socket.once('end', () => { try { resolve(JSON.parse(output)); } catch { reject(Error('Invalid control result')); } });
    });
    console.log(JSON.stringify(reply, null, 2)); if (reply.error) process.exitCode = 1;
  } else { console.error('Usage: node scripts/live-bridge.ts start | control link|pending|approve ID|status|stop'); process.exitCode = 1; }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
