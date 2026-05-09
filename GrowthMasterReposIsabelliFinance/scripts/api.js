// Auto-generated API helper for Claude Code agents
// Usage:
//   node scripts/api.js status <employeeId> "your markdown status here"
//   node scripts/api.js task-done <employeeId> <taskId> "result description"
//   node scripts/api.js task-update <employeeId> <taskId> "updated result"
//   node scripts/api.js idle <employeeId>
//   node scripts/api.js get <path>
//   node scripts/api.js post <path> '{"key":"value"}'

const http = require('http');
const [,, cmd, ...args] = process.argv;
const BASE = 'http://localhost:3777/api/employees';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    }).on('error', reject);
  });
}

(async () => {
  try {
    let result;
    switch (cmd) {
      case 'status': {
        const [empId, ...statusParts] = args;
        result = await post(BASE + '/' + empId + '/self/working-status', { status: statusParts.join(' ') });
        break;
      }
      case 'task-done': {
        const [empId, taskId, ...resultParts] = args;
        result = await post(BASE + '/' + empId + '/self/task-done', { taskId, result: resultParts.join(' ') });
        break;
      }
      case 'task-update': {
        const [empId, taskId, ...resultParts] = args;
        result = await post(BASE + '/' + empId + '/self/task-update', { taskId, result: resultParts.join(' ') });
        break;
      }
      case 'idle': {
        const [empId] = args;
        result = await post(BASE + '/' + empId + '/self/status', { status: 'idle' });
        break;
      }
      case 'my-status': {
        const [empId] = args;
        const emp = await get(BASE + '/' + empId);
        if (emp && typeof emp === 'object') {
          console.log('=== WORKING STATUS ===');
          console.log(emp.workingStatus || '(none)');
          console.log('\n=== TASKS ===');
          for (const t of (emp.taskHistory || []).slice(-5).reverse()) {
            const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '🔄';
            console.log(icon + ' [' + t.status + '] ' + t.description);
            if (t.result) console.log('   Result: ' + t.result.substring(0, 200));
          }
          console.log('\n=== STATUS: ' + emp.status + ' ===');
        }
        process.exit(0);
      }
      case 'get': {
        result = await get('http://localhost:3777' + args[0]);
        break;
      }
      case 'post': {
        result = await post('http://localhost:3777' + args[0], JSON.parse(args[1] || '{}'));
        break;
      }
      default:
        console.error('Commands: status, task-done, task-update, idle, get, post');
        process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
})();
